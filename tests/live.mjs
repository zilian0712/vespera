import assert from 'node:assert/strict';
import WebSocket from 'ws';
const base=process.env.TEST_BASE;
if(!base)throw new Error('Set TEST_BASE to the deployed site origin');
const peers=[];
async function connect(room,id,token=room.token){
  const url=new URL(`/api/rooms/${room.roomId}/ws`,base);url.protocol='wss:';url.search=new URLSearchParams({token,clientId:id,name:id});
  const ws=new WebSocket(url,{origin:base});const messages=[];ws.on('message',raw=>messages.push(JSON.parse(raw)));peers.push(ws);
  await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',()=>reject(new Error('WebSocket connection failed')));});
  const wait=async predicate=>{const until=Date.now()+12000;while(Date.now()<until){const found=messages.find(predicate);if(found)return found;await new Promise(r=>setTimeout(r,30));}throw new Error('Timed out waiting for expected room message');};
  await wait(m=>m.type==='snapshot');return {ws,messages,wait,send:data=>ws.send(JSON.stringify(data))};
}
try{
  const page=await fetch(base);assert.equal(page.status,200);assert.match(await page.text(),/芝麻同看/);console.log('PASS deployed HTML');
  const response=await fetch(new URL('/api/rooms',base),{method:'POST',headers:{Origin:base}});assert.equal(response.status,201);const room=await response.json();console.log('PASS create private room');
  const a=await connect(room,'live-first'),b=await connect(room,'live-second');await a.wait(m=>m.type==='state'&&m.members.length===2);console.log('PASS two real WebSocket peers');
  a.send({type:'media',url:'https://example.com/test.mp4',kind:'video',title:'Deployment check'});await b.wait(m=>m.type==='state'&&m.media?.title==='Deployment check');
  a.send({type:'control',action:'play'});await b.wait(m=>m.type==='state'&&m.playback.paused===false);console.log('PASS playback broadcast');
  a.send({type:'control',action:'seek',position:123});await b.wait(m=>m.type==='state'&&m.playback.position>=123);console.log('PASS seek broadcast');
  b.send({type:'chat',text:'Deployment check'});await a.wait(m=>m.type==='chat'&&m.message.text==='Deployment check');console.log('PASS chat broadcast');
  const before=Date.now();a.send({type:'ping',clientTime:before});await a.wait(m=>m.type==='pong'&&m.clientTime===before);console.log('Observed container RTT (not user network):',Date.now()-before,'ms');
  await assert.rejects(connect(room,'live-third'));console.log('PASS third peer rejected');
  await assert.rejects(connect(room,'wrong-token','invalid'));console.log('PASS invalid invitation rejected');
  a.send({type:'status',ready:true,buffering:false});b.send({type:'status',ready:true,buffering:false});a.send({type:'settings',waitTogether:true});await a.wait(m=>m.type==='state'&&m.waitTogether);
  const beforeBuffer=a.messages.filter(m=>m.type==='state').at(-1).playback.seekRevision;
  const marker=a.messages.length;b.send({type:'status',ready:false,buffering:true});const waiting=await a.wait(m=>a.messages.indexOf(m)>=marker&&m.type==='state'&&m.playback.paused);assert.equal(waiting.playback.seekRevision,beforeBuffer);console.log('PASS wait-together pause preserves seek marker');
  const recovery=a.messages.length;b.send({type:'status',ready:true,buffering:false});const resumed=await a.wait(m=>a.messages.indexOf(m)>=recovery&&m.type==='state'&&!m.playback.paused);assert.equal(resumed.playback.seekRevision,beforeBuffer);console.log('PASS wait-together resume preserves seek marker');
  a.send({type:'control',action:'pause'});
  const paused=await a.wait(m=>m.type==='state'&&m.playback.paused&&m.userPaused);
  const fractional=b.messages.length;
  a.send({type:'control',action:'seek',position:123.456});
  const sought=await b.wait(m=>b.messages.indexOf(m)>=fractional&&m.type==='state'&&m.playback.position===123.456);
  assert.equal(sought.playback.position,123.456);assert.equal(sought.playback.seekRevision,beforeBuffer+1);console.log('PASS millisecond seek and independent marker preserved');
  b.send({type:'telemetry',position:123.456,paused:true,rate:1,revision:sought.playback.revision,measuredAt:Date.now()});
  await a.wait(m=>m.type==='telemetry'&&m.clientId==='live-second'&&m.position===123.456);console.log('PASS peer telemetry broadcast');
  assert.ok(paused.userPaused);
  console.log('LIVE ROOM CHECKS PASSED; video loading and two-user network sync remain separate checks');
} finally {for(const ws of peers)ws.close();}
