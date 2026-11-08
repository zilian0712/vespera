import React from 'react';
import {createRoot} from 'react-dom/client';
import {useRoom} from '../src/room';
import Player from '../src/Player';
import '../src/style.css';
const params=new URLSearchParams(location.hash.slice(1));
sessionStorage.setItem('zhima-client',params.get('client')||crypto.randomUUID());
function Fixture(){
  const state=useRoom(params.get('room')||'',params.get('key')||'',params.get('client')||'QA');
  Object.assign(window,{qaRoom:state});
  return <Player media={state.room?.media||null} playback={state.room?.playback} userPaused={state.room?.userPaused??true} serverNow={state.serverNow} clockReady={state.clockReady} peerTelemetry={state.peerTelemetry} send={state.send} messages={state.room?.chat||[]} connected={state.connection==='已连接'} onTyping={()=>{}} onSource={()=>{}}/>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
