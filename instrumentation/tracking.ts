import { randomUUID } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";

const tracking = channel("santa-lab.provider.v1");

/** Optional lab instrumentation through the public provider wrapper contract. */
export function wrapCerebrasTracking(ctx: ProviderWrapStreamFnContext) {
  if (!ctx.streamFn || !tracking.hasSubscribers) {
    return ctx.streamFn;
  }
  const inner = ctx.streamFn;
  return async (...args: Parameters<typeof inner>) => {
    const [model, context, options] = args;
    const callId = options?.requestId ?? randomUUID();
    const started = performance.now();
    const publish = (type: string, data: Record<string, unknown> = {}) => {
      tracking.publish({
        type,
        callId,
        at: new Date().toISOString(),
        elapsedMs: performance.now() - started,
        provider: model.provider,
        model: model.id,
        ...data,
      });
    };
    publish("start", { sessionId: options?.sessionId });
    try {
      const source = await inner(model, context, {
        ...options,
        onPayload: async (payload, resolvedModel) => {
          const prior = await options?.onPayload?.(payload, resolvedModel);
          const effective = prior ?? payload;
          // Detached boundary: an observer cannot mutate the submitted object.
          const observation = {
            payload: structuredClone(effective),
            replacement: undefined as unknown,
          };
          publish("payload", { observation });
          return observation.replacement ?? prior;
        },
        onResponse: async (response, resolvedModel) => {
          publish("response", {
            status: response.status,
            requestId: response.headers?.["x-request-id"] ?? response.headers?.["request-id"],
          });
          await options?.onResponse?.(response, resolvedModel);
        },
      });
      // Observe native completion once without consuming or buffering model events.
      const result = source.result().then(
        (message) => {
          publish("end", { message });
          return message;
        },
        (error: unknown) => {
          publish("error", { error: String(error) });
          throw error;
        },
      );
      // Keep result-only rejections observed even when a caller consumes events only.
      void result.catch(() => undefined);
      let firstDelta = false;
      let firstVisible = false;
      return {
        push: source.push.bind(source),
        end: source.end.bind(source),
        result: () => result,
        [Symbol.asyncIterator]() {
          const iterator = source[Symbol.asyncIterator]();
          return {
            async next() {
              const next = await iterator.next();
              if (!next.done) {
                const event = next.value;
                if (
                  !firstDelta &&
                  (event.type === "text_delta" ||
                    event.type === "thinking_delta" ||
                    event.type === "toolcall_delta")
                ) {
                  firstDelta = true;
                  publish("first-delta");
                }
                if (!firstVisible && event.type === "text_delta") {
                  firstVisible = true;
                  publish("first-visible");
                }
              }
              return next;
            },
            ...(iterator.return ? { return: iterator.return.bind(iterator) } : {}),
            ...(iterator.throw ? { throw: iterator.throw.bind(iterator) } : {}),
          };
        },
      };
    } catch (error) {
      publish("error", { error: String(error) });
      throw error;
    }
  };
}
