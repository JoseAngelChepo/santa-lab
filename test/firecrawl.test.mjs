import test from 'node:test';
import assert from 'node:assert/strict';
import { firecrawlBatch,firecrawlTools,publicProductUrl,firecrawlDelivery,compactPageEvidence,rankCandidates,retailSearchQuery } from '../firecrawl.mjs';

for(const n of [3,5])test(`${n} gifts start exactly ${n} parallel requests, without serializing`,async()=>{
  let active=0,maxActive=0,started=0;const pending=[];const recorded=[];
  const fetchFn=async(url,options)=>{
    assert.equal(url,'https://api.firecrawl.dev/v2/search');assert.equal(options.headers.authorization,'Bearer test-key');
    active++;started++;maxActive=Math.max(maxActive,active);
    await new Promise(resolve=>pending.push(resolve));active--;
    return new Response(JSON.stringify({success:true,data:{web:[{url:'https://shop.example/product',title:'Product'}]}}),{status:200});
  };
  const promise=firecrawlBatch({kind:'search',items:Array.from({length:n},(_,i)=>({gift:`gift ${i}`,query:`query ${i}`})),key:'test-key',record:e=>recorded.push(e),fetchFn,toolCallId:'call'});
  assert.equal(started,n);assert.equal(maxActive,n);for(const resolve of pending)resolve();const result=await promise;
  assert.equal(result.parallelism,n);assert.equal(result.results.length,n);assert.ok(result.results.every(r=>r.ok));assert.equal(recorded.filter(e=>e.phase==='start').length,n);assert.equal(recorded.filter(e=>e.phase==='end').length,n);assert.ok(recorded.every(e=>e.toolCallId==='call'));
});
test('all results are preserved when one member fails; verification requests use fresh product pages',async()=>{
  const result=await firecrawlBatch({kind:'scrape',items:[{gift:'one',url:'https://store.example/product1'},{gift:'two',url:'https://store.example/product2'}],key:'key',fetchFn:async(_url,options)=>{
    const body=JSON.parse(options.body);assert.equal(body.maxAge,0);assert.deepEqual(body.formats,['markdown']);
    return new Response(JSON.stringify(body.url.endsWith('1')?{success:true,data:{markdown:'Product $20',metadata:{statusCode:200}}}:{success:false,error:'Not found'}),{status:body.url.endsWith('1')?200:404});
  }});
  assert.equal(result.results.length,2);assert.equal(result.results[0].ok,true);assert.equal(result.results[1].ok,false);
});
test('missing key and invalid/private URLs fail before network calls',async()=>{
  await assert.rejects(firecrawlBatch({kind:'search',items:[{gift:'a',query:'gift'}]}),/FIRECRAWL_API_KEY/);
  for(const url of ['http://127.0.0.1/a','http://localhost/a','file:///tmp/a','https://user:pass@shop.example/a','https://host.internal/a'])assert.throws(()=>publicProductUrl(url));
  assert.equal(publicProductUrl('https://shop.example/products/one'),'https://shop.example/products/one');
  assert.equal(firecrawlTools({record(){}}).length,2);
});

test('five huge pages retain every identity and quoted price inside the actual deferred-tool envelope',()=>{
  const batch={batchId:'test',kind:'scrape',parallelism:5,results:Array.from({length:5},(_,i)=>({index:i,gift:`gift ${i}`,ok:true,httpStatus:200,url:`https://shop.example/products/${i}`,data:{data:{metadata:{title:`Product ${i}`,statusCode:200},markdown:`${'![gallery](https://cdn.example/image.jpg)\n'.repeat(20000)}# Product ${i}\nCurrent price\n$${20+i}.99 USD\nIn stock\n${'Unrelated navigation and recommendations.\n'.repeat(10000)}`}}}))};
  const result=firecrawlDelivery(batch),payload=JSON.parse(result.content[0].text);
  assert.equal(payload.results.length,5);
  payload.results.forEach((r,i)=>{assert.equal(r.title,`Product ${i}`);assert.ok(JSON.stringify(r.evidence.priceQuotes).includes(`$${20+i}.99`));assert.ok(r.evidence.availabilityQuotes.includes('In stock'));});
  const wire=JSON.stringify({tool:{id:'openclaw:santa-lab:firecrawl_scrape_batch',name:'firecrawl_scrape_batch',source:'openclaw'},result},null,2);
  assert.ok(wire.length<=18000);assert.ok(!wire.includes('[truncated]'));assert.equal(batch.results[0].data.data.markdown.length>100000,true);
  assert.equal(result.details.results,undefined);
});

test('delivery preserves errors and retry delay without presenting a failed page as evidence',()=>{
  const result=firecrawlDelivery({batchId:'test',kind:'scrape',parallelism:1,results:[{index:0,gift:'cook',url:'https://shop.example/a',ok:false,httpStatus:429,data:{error:'Rate limit exceeded',retry_after_seconds:27}}]});
  const item=JSON.parse(result.content[0].text).results[0];assert.equal(item.ok,false);assert.equal(item.retryAfterSeconds,27);assert.equal(item.evidence,undefined);
});
test('compact delivery preserves five real price witnesses and currency without stock boilerplate or raw-page duplication',()=>{
  const batch={batchId:'compact',kind:'scrape',parallelism:5,results:Array.from({length:5},(_,i)=>({index:i,gift:`gift ${i}`,ok:true,httpStatus:200,url:`https://shop.example/products/${i}`,data:{data:{metadata:{title:`Product ${i}`,statusCode:200,'product:price:currency':'USD'},markdown:`# Product ${i}\nSize: 32 oz\nCurrent price\n$${20+i}.99 USD\nIn stock\n${'Long product navigation.\n'.repeat(30000)}`}}}))};
  const result=firecrawlDelivery(batch,{compact:true}),payload=JSON.parse(result.content[0].text);
  assert.equal(payload.delivery,'compact-price-evidence-v2.4');assert.equal(payload.results.length,5);
  payload.results.forEach((r,i)=>{assert.ok(JSON.stringify(r.evidence.priceQuotes).includes(`$${20+i}.99`));assert.equal(r.priceMetadata['product:price:currency'],'USD');assert.equal(r.evidence.availabilityQuotes,undefined);});
  assert.ok(result.content[0].text.length<6000);assert.ok(!result.content[0].text.includes('Long product navigation'));assert.equal(result.details.results,undefined);
});
test('selection demotes category pages and keeps original search rank between matching products',()=>{
  const results=[{url:'https://shop.example/s?k=manual+coffee+grinder',title:'Manual coffee grinder',position:1},{url:'https://store.example/itm/123',title:'Manual coffee grinder',position:2},{url:'https://store.example/ip/456',title:'Manual coffee grinder',position:3}];
  const ranked=rankCandidates(results,'manual coffee grinder');
  assert.deepEqual(ranked.map(r=>r.originalPosition),[2,3,1]);assert.equal(ranked[0].selectionHint,'direct-product');assert.equal(ranked[2].selectionHint,'listing-or-review');assert.deepEqual(results.map(r=>r.position),[1,2,3]);
});
test('selection does not favor a direct product with the wrong explicit model number',()=>{
  const ranked=rankCandidates([{url:'https://shop.example/products/console-old',title:'Console 1',position:1},{url:'https://shop.example/products/console-new',title:'Console 2',position:2}],'Console 2');
  assert.equal(ranked[0].title,'Console 2');assert.equal(ranked[1].selectionHint,'check-model-number');
});
test('retail intent preserves explicit search preferences and logs the actual five-candidate request',async()=>{
  assert.equal(retailSearchQuery('manual coffee grinder'),'manual coffee grinder buy');
  for(const query of ['coffee grinder buy','coffee grinder site:shop.example','comprar molino manual'])assert.equal(retailSearchQuery(query),query);
  const batch=await firecrawlBatch({kind:'search',items:[{gift:'grinder',query:'manual coffee grinder'}],key:'key',searchLimit:5,retailIntent:true,fetchFn:async(_url,options)=>{
    const request=JSON.parse(options.body);assert.equal(request.query,'manual coffee grinder buy');assert.equal(request.limit,5);
    return new Response(JSON.stringify({success:true,data:{web:[]}}),{status:200});
  }});
  assert.equal(batch.results[0].requestedQuery,'manual coffee grinder');assert.equal(batch.results[0].query,'manual coffee grinder buy');
});
test('live product links embedded in review search results are usable without another search, but remain unverified',()=>{
  const source={url:'https://review.example/best-hand-mills',title:'Best manual coffee grinders',description:'[Hand Mill Pro](https://maker.example/products/hand-mill) [Photo](https://cdn.example/products/mill.jpg) [Invalid](http://127.0.0.1/products/mill)'};
  const ranked=rankCandidates([source],'manual coffee grinder');
  assert.equal(ranked[0].url,'https://maker.example/products/hand-mill');assert.equal(ranked[0].linkedFrom,source.url);assert.equal(ranked[0].selectionHint,'direct-product');assert.equal(ranked[0].price,undefined);assert.equal(ranked.length,2);
  assert.equal(source.linkedFrom,undefined);
});
test('prices of recommended items before and after the actual product are excluded',()=>{
  const markdown='# Product summary presents key product information\n## Consider these available items\nOther grinder\n[$31.98](https://shop.example/same-page)\n# Chidori Manual Coffee Grinder\nCurrently unavailable\n## Products related to this item\nOther coffee grinder\n$44.99 USD';
  const evidence=compactPageEvidence(markdown,1500,'Amazon.com: Chidori Manual Coffee Grinder');
  assert.equal(evidence.scope,'product-section');assert.deepEqual(evidence.priceQuotes,[]);
  const priced=compactPageEvidence(markdown.replace('Currently unavailable','Current price\n$27.95 USD'),1500,'Chidori Manual Coffee Grinder');
  assert.ok(priced.priceQuotes.some(q=>q.includes('$27.95')));assert.ok(!JSON.stringify(priced).includes('$31.98'));assert.ok(!JSON.stringify(priced).includes('$44.99'));
});
