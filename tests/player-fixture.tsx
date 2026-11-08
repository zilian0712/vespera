import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import Player from '../src/Player';
import {projectPosition} from '../src/sync';
import type {Media,Message,Playback} from '../src/room';
import '../src/style.css';

const testOrientation = new URLSearchParams(location.search).get('orientation');
if (testOrientation) Object.defineProperty(screen.orientation, 'type', { configurable: true, get: () => testOrientation });
const controls: object[]=[];
Object.assign(window,{playerCommands:controls});
function Fixture(){
  const [media,setMedia]=useState<Media|null>(null);
  Object.assign(window,{loadTestMedia:(url:string)=>setMedia({kind:'video',url,title:'测试影片',id:crypto.randomUUID()})});
  const [playback,setPlayback]=useState<Playback>({paused:true,position:0,rate:1,updatedAt:Date.now(),revision:0,seekRevision:0});
  const [messages,setMessages]=useState<Message[]>([]);
  const [typing,setTyping]=useState(false);
  const now=React.useCallback(()=>Date.now(),[]);
  const [source,setSource]=useState('');
  const send=React.useCallback((data:any)=>{
    controls.push(data);
    if(data.type==='control')setPlayback(old=>({...old,position:data.action==='seek'?data.position:projectPosition(old,Date.now()),paused:data.action==='play'?false:data.action==='pause'?true:old.paused,rate:data.action==='rate'?data.rate:old.rate,updatedAt:Date.now(),revision:old.revision+1,seekRevision:data.action==='seek'?(old.seekRevision||0)+1:old.seekRevision}));
    if(data.type==='chat')setMessages(old=>[...old,{id:crypto.randomUUID(),text:data.text,name:'测试',createdAt:Date.now(),videoTime:0}]);
    return true;
  },[]);
  Object.assign(window,{controlTest:send,readTest:()=>playback});
  return <div className={`watch-app ${typing?'typing':''}`} style={{'--app-height':'100dvh'} as React.CSSProperties}><header className="app-header">播放器交互验证</header><main className="watch-layout"><section className="viewing-column"><Player media={media} playback={playback} userPaused={playback.paused} serverNow={now} clockReady={true} peerTelemetry={null} send={send} messages={messages} connected={true} onTyping={setTyping} onSource={()=>{}}/>{!media&&<form onSubmit={event=>{event.preventDefault();setMedia({kind:'video',url:source,title:'测试影片',id:crypto.randomUUID()});}}><input aria-label="测试片源" value={source} onChange={event=>setSource(event.target.value)} /><button>加载测试片源</button></form>}</section><aside className="conversation"><div className="messages">{messages.map(message=><p key={message.id}>{message.text}</p>)}</div></aside></main></div>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
