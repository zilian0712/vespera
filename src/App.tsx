import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { ArrowUpRight, Check, ChevronLeft, ChevronRight, Film, Globe, Link, Plus, Settings2, Tv, Users, X } from 'lucide-react';
import AnimeBrowser, { type SelectedAnimeMedia } from './AnimeBrowser';
import { buildAnimeMediaMeta, fetchAnimeDanmaku, fetchAnimeDetail, fetchAnimeVod, selectPlayableVodLines, type TimelineDanmakuItem } from './anime';
import Player, { formatTime } from './Player';
import { createRoom, useRoom } from './room';
import { useViewport } from './viewport';
import togetherScreen from './assets/together-screen.svg';
import sharedNotes from './assets/shared-notes.svg';
import ReactionContent from './ReactionContent';
import { useVoice } from './useVoice';
import VoicePanel from './VoicePanel';

function readStoredName(): string {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem('zhima-name') || '' : '';
  } catch {
    return '';
  }
}

function writeStoredName(value: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem('zhima-name', value);
  } catch {
    // Ignore private-mode storage errors.
  }
}

function parseHashRoom(): { roomId: string; token: string } {
  const params = new URLSearchParams(typeof location !== 'undefined' ? location.hash.slice(1) : '');
  return {
    roomId: params.get('room') || '',
    token: params.get('key') || '',
  };
}

export default function App() {
  const [initialHash] = useState(parseHashRoom);
  const [roomId, setRoomId] = useState(initialHash.roomId);
  const [token, setToken] = useState(initialHash.token);
  const [name, setName] = useState(readStoredName);
  const [draftName, setDraftName] = useState(name);
  const [joining, setJoining] = useState(() => Boolean(initialHash.roomId && !name));
  const [pendingCreate, setPendingCreate] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [sourceTab, setSourceTab] = useState<'anime' | 'video' | 'web'>('anime');
  const [roomSettings, setRoomSettings] = useState(false);
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [switchingEp, setSwitchingEp] = useState(false);
  const [copied, setCopied] = useState(false);
  const [typing, setTyping] = useState(false);
  const [timelineDanmaku, setTimelineDanmaku] = useState<TimelineDanmakuItem[]>([]);
  const viewport = useViewport();
  const { room, connection, error, clearError, latency, clientId, send, serverNow, clockReady, peerTelemetry } = useRoom(roomId, token, name);
  const messages = useRef<HTMLDivElement>(null);
  const nameRef = useRef(name);
  nameRef.current = name;
  const setInputActive = useCallback((value: boolean) => setTyping(value), []);
  const openSource = useCallback(() => setSourceOpen(true), []);

  useEffect(() => {
    const syncFromLocation = () => {
      const next = parseHashRoom();
      setRoomId(next.roomId);
      setToken(next.token);
      if (next.roomId && !nameRef.current) setJoining(true);
    };
    window.addEventListener('hashchange', syncFromLocation);
    window.addEventListener('popstate', syncFromLocation);
    return () => {
      window.removeEventListener('hashchange', syncFromLocation);
      window.removeEventListener('popstate', syncFromLocation);
    };
  }, []);

  useEffect(() => {
    const list = messages.current;
    if (list && list.scrollHeight - list.scrollTop - list.clientHeight < 160) list.scrollTop = list.scrollHeight;
  }, [room?.chat.length]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 6500);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSourceOpen(false);
        setRoomSettings(false);
        setPendingCreate(false);
        if (name || !roomId) setJoining(false);
      }
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [name, roomId]);

  const animeMeta = room?.media?.anime;
  useEffect(() => {
    if (!animeMeta) {
      setTimelineDanmaku([]);
      return;
    }
    const controller = new AbortController();
    setTimelineDanmaku([]);
    fetchAnimeDanmaku(
      animeMeta.bangumiId,
      animeMeta.episode,
      {
        biliCid: animeMeta.biliCid || animeMeta.biliHmtCid,
        qqVid: animeMeta.qqVid,
      },
      controller.signal,
    )
      .then(res => setTimelineDanmaku(res.items))
      .catch(() => {
        if (!controller.signal.aborted) setTimelineDanmaku([]);
      });
    return () => controller.abort();
  }, [animeMeta?.bangumiId, animeMeta?.episode, animeMeta?.biliCid, animeMeta?.biliHmtCid, animeMeta?.qqVid]);

  async function createWithReadyName() {
    setBusy(true);
    try {
      const data = await createRoom();
      setRoomId(data.roomId);
      setToken(data.token);
      history.pushState(null, '', `#${new URLSearchParams({ room: data.roomId, key: data.token })}`);
    } catch (failure) {
      setNotice(failure instanceof Error ? failure.message : '创建房间失败');
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    if (!name) {
      setPendingCreate(true);
      setJoining(true);
      return;
    }
    await createWithReadyName();
  }

  function saveName(event: FormEvent) {
    event.preventDefault();
    const value = draftName.trim();
    if (!value) return;
    writeStoredName(value);
    setName(value);
    setJoining(false);
    if (pendingCreate) {
      setPendingCreate(false);
      void createWithReadyName();
    }
  }

  async function invite() {
    try {
      await navigator.clipboard.writeText(location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setNotice('请从浏览器地址栏复制完整的邀请链接发给朋友');
    }
  }

  function addMedia(event: FormEvent) {
    event.preventDefault();
    const kind = sourceTab === 'web' ? 'web' : 'video';
    try {
      const parsed = new URL(url.trim());
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
        throw new Error('请输入不含账号密码的 HTTPS 链接');
      }
      if (kind === 'web' && parsed.origin === location.origin) {
        throw new Error('网页浏览不能嵌入当前放映室站点，请输入外部 HTTPS 网址');
      }
      if (!send({
        type: 'media',
        url: parsed.href,
        kind,
        title: title.trim() || (kind === 'video' ? '今晚的电影' : parsed.hostname),
      })) {
        throw new Error('房间尚未连接，请稍后重试');
      }
      setSourceOpen(false);
      setUrl('');
      setTitle('');
    } catch (failure) {
      setNotice(failure instanceof Error ? failure.message : '请填写完整的网址');
    }
  }

  function selectAnimeMedia(selected: SelectedAnimeMedia) {
    if (!send({
      type: 'media',
      kind: 'video',
      url: selected.url,
      title: selected.title,
      anime: selected.anime,
    })) {
      setNotice('房间尚未连接，请稍后重试');
      return;
    }
    setSourceOpen(false);
  }

  async function jumpEpisode(targetEpisode: number) {
    if (!animeMeta || switchingEp || targetEpisode < 1) return;
    setSwitchingEp(true);
    try {
      const [bundle, rawLines] = await Promise.all([
        fetchAnimeDetail(animeMeta.bangumiId),
        fetchAnimeVod(animeMeta.bangumiId, targetEpisode),
      ]);
      const playable = selectPlayableVodLines(rawLines);
      if (!playable.length) {
        throw new Error(`第 ${targetEpisode} 话暂无可用的 HTTPS 播放线路`);
      }
      const preferredLine = (animeMeta.lineCaption
        ? playable.find(line => (line.caption || line.type) === animeMeta.lineCaption)
        : undefined) || playable[0];
      const epInfo = bundle.episodes.find(item => item.episode === targetEpisode) || {
        episode: targetEpisode,
        title: '',
        image: '',
        airdate: 0,
        bili: '',
        biliHmt: '',
        qq: '',
        iqiyi: '',
        youku: '',
      };
      const epLabel = epInfo.title?.trim() ? `第 ${targetEpisode} 话 · ${epInfo.title.trim()}` : `第 ${targetEpisode} 话`;
      send({
        type: 'media',
        kind: 'video',
        url: preferredLine.url,
        title: `${bundle.detail.title} ${epLabel}`.slice(0, 200),
        anime: buildAnimeMediaMeta(bundle.detail, epInfo, preferredLine.caption || preferredLine.type, bundle.episodes.length),
      });
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '切换集数失败，请打开选集面板重试');
    } finally {
      setSwitchingEp(false);
    }
  }

  const friend = room?.members.find(member => member.clientId !== clientId);
  const connected = connection === '已连接';
  const voice = useVoice({ roomId, token, clientId, friendId: friend?.clientId || '', connected });

  return <div className={`watch-app ${typing ? 'typing' : ''} ${roomId ? 'in-room' : 'home'}`} style={{ '--app-height': `${viewport.height}px`, '--app-top': `${viewport.top}px` } as CSSProperties}>
    <header className="app-header">
      <a className="brand" href="/" aria-label="芝麻同看首页" onClick={event => {
        if (!roomId) return;
        event.preventDefault();
        setRoomId('');
        setToken('');
        clearError();
        setNotice('');
        history.pushState(null, '', location.pathname + location.search);
      }}><span className="brand-mark"><i /><i /></span><span>芝麻同看</span></a>
      <div className="header-presence">{roomId && <span className={`status-dot ${connected ? 'online' : ''}`} />}<span>{roomId ? friend ? `${name} & ${friend.name}` : '等朋友入座' : '两个人的放映室'}</span></div>
      <div className="header-actions"><button className="icon-button" aria-label={roomId ? '房间设置' : '设置'} onClick={() => setRoomSettings(true)}><Settings2 size={20} /></button>{roomId && <button className="button invite-button" onClick={invite}>{copied ? <Check size={16} /> : <Link size={16} />}<span>{copied ? '已复制' : '邀请'}</span></button>}</div>
    </header>
    <main className="watch-layout">
      <section className="viewing-column" aria-label="放映室">
        {roomId ? <>
          <Player
            media={room?.media || null}
            playback={room?.playback}
            userPaused={room?.userPaused ?? true}
            serverNow={serverNow}
            clockReady={clockReady}
            peerTelemetry={peerTelemetry}
            send={send}
            messages={room?.chat || []}
            timelineDanmaku={timelineDanmaku}
            connected={connected}
            onTyping={setInputActive}
            onSource={openSource}
            voiceControls={<VoicePanel voice={voice} compact />}
          />
          <div className="film-info"><div><h1>{room?.media?.title || '今晚看什么？'}</h1><div className="room-health"><span className={`status-dot ${connected ? 'online' : ''}`} /><span>{connection}</span>{latency !== null && <span>网络往返 {Math.round(latency)} ms</span>}{room?.media?.kind === 'web' && <span>网页浏览不支持播放同步</span>}</div></div>{room?.media && <button className="text-button" onClick={openSource}><Plus size={17} />换片源</button>}</div>
          {animeMeta && (
            <div className="anime-room-bar" aria-label="番剧选集控制">
              <div className="anime-room-info">
                <span className="anime-room-tag"><Tv size={13} />番剧同看</span>
                <span>第 {animeMeta.episode}{animeMeta.episodesTotal ? ` / ${animeMeta.episodesTotal}` : ''} 话</span>
                {animeMeta.lineCaption && <span>线路：{animeMeta.lineCaption}</span>}
                {timelineDanmaku.length > 0 && <span>弹幕池 {timelineDanmaku.length} 条</span>}
              </div>
              <div className="anime-room-actions">
                <button
                  type="button"
                  disabled={!connected || switchingEp || animeMeta.episode <= 1}
                  onClick={() => void jumpEpisode(animeMeta.episode - 1)}
                >
                  <ChevronLeft size={14} />上一话
                </button>
                <button
                  type="button"
                  disabled={!connected || switchingEp || Boolean(animeMeta.episodesTotal && animeMeta.episode >= animeMeta.episodesTotal)}
                  onClick={() => void jumpEpisode(animeMeta.episode + 1)}
                >
                  下一话<ChevronRight size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSourceTab('anime');
                    setSourceOpen(true);
                  }}
                >
                  选集 / 换线路
                </button>
              </div>
            </div>
          )}
        </> : <>
          <div className="welcome-stage">
            <div className="welcome-content"><h1>好电影，<br />想和你一起看。</h1><p>分享一个邀请链接，<br />和另一个人同步看电影、追新番。</p><button className="button" onClick={() => void create()} disabled={busy}>{busy ? '正在创建…' : '创建双人房间'}</button><span className="welcome-caption">无需下载，内置番剧片库与直链同看，手机和电脑都能加入。</span>{notice && <p className="welcome-error" role="alert">{notice}</p>}</div>
            <img className="welcome-illustration" src={togetherScreen} width="640" height="220" alt="一块银幕前，并排坐着两个人" />
          </div>
        </>}
        {room && <div className="watch-options"><label className="switch-label"><input type="checkbox" checked={room.waitTogether} disabled={room.media?.kind === 'web'} onChange={event => send({ type: 'settings', waitTogether: event.target.checked })} /><span />缓冲时等对方</label><span className="online-count"><Users size={14} />{room.members.length} / 2 人在场</span></div>}
        {roomId && <div className="room-voice"><VoicePanel voice={voice} /></div>}
        {roomId && (error || notice) && <div className="notice" role="alert">{notice || error}<button aria-label="关闭提示" onClick={() => { setNotice(''); clearError(); }}><X size={15} /></button></div>}
      </section>
      {roomId && <aside className="conversation" aria-label="聊天记录">
        <div className="room-company">
          <div className="company-heading"><h2>{friend ? '两个人，刚刚好。' : '为你留了一个位置。'}</h2><p>{friend ? '同一部电影，同一个此刻。' : '把邀请发给想一起看的人。'}</p></div>
          <div className="room-seats" aria-label="房间成员">
            <div className={`room-seat ${connected ? 'occupied' : 'waiting'}`}><SeatIllustration /><div><strong title={name}>{name || '你'}</strong><span>{connected ? '已入座' : connection}</span></div></div>
            <div className={`room-seat ${friend && connected ? 'occupied' : 'waiting'}`}><SeatIllustration /><div><strong title={friend?.name}>{friend?.name || '朋友的座位'}</strong><span>{friend ? connected ? '已入座' : connection : '等待入座'}</span></div></div>
          </div>
          {!friend && <button className="seat-invite" onClick={invite}>{copied ? <Check size={15} /> : <Link size={15} />}{copied ? '已复制' : '复制邀请链接'}</button>}
        </div>
        <div className="conversation-header"><h2>一起聊聊</h2><span>{room?.chat.length ? `${room.chat.length} 条消息` : '从这一幕聊起'}</span></div>
        <div className="messages" ref={messages} aria-live="polite">{!room?.chat.length ? <div className="chat-empty"><img className="chat-illustration" src={sharedNotes} width="260" height="144" alt="" /><p>{room?.media ? '喜欢这一幕，就聊两句。' : '开场前，先聊两句。'}</p><span>从画面下方发弹幕，<br />聊天记录会留在这里。</span></div> : room.chat.map(message => {
          const own = message.clientId ? message.clientId === clientId : message.name === name;
          return <div className={`message ${own ? 'own' : ''}`} key={message.id}><div className="message-meta"><span>{message.name}</span><time>{formatTime(message.videoTime)}</time></div><p><ReactionContent text={message.text} /></p></div>;
        })}</div>
      </aside>}
    </main>
    {joining && <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="name-heading">{(name || !roomId) && <button className="modal-close icon-button" aria-label="关闭" onClick={() => { setJoining(false); setPendingCreate(false); }}><X size={20} /></button>}<div className="modal-symbol"><Users size={25} /></div><h2 id="name-heading">怎么称呼你？</h2><p>这个名字会出现在房间和弹幕里。</p><form onSubmit={saveName}><label>昵称<input autoFocus value={draftName} onChange={event => setDraftName(event.target.value)} maxLength={40} placeholder="输入你的昵称" required /></label><button className="button full">{pendingCreate ? '创建并进入放映室' : roomId ? '进入放映室' : '保存昵称'}<ArrowUpRight size={17} /></button></form></section></div>}
    {sourceOpen && <div className="modal-backdrop"><section className={`modal source-modal ${sourceTab === 'anime' ? 'source-modal-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby="source-heading"><button className="modal-close icon-button" aria-label="关闭" onClick={() => setSourceOpen(false)}><X size={20} /></button><div className="projector-illustration source-illustration" aria-hidden="true" /><h2 id="source-heading">今晚看什么？</h2><p>{sourceTab === 'anime' ? '搜索番剧、挑选集数与线路，和对方同步开场。' : '粘贴你和朋友都能访问的链接。'}</p><div className="source-tabs"><button type="button" className={sourceTab === 'anime' ? 'selected' : ''} onClick={() => setSourceTab('anime')}><Tv size={17} />番剧片库</button><button type="button" className={sourceTab === 'video' ? 'selected' : ''} onClick={() => setSourceTab('video')}><Film size={17} />视频直链</button><button type="button" className={sourceTab === 'web' ? 'selected' : ''} onClick={() => setSourceTab('web')}><Globe size={17} />网页浏览</button></div>{sourceTab === 'anime' ? <AnimeBrowser connected={connected} initialBangumiId={animeMeta?.bangumiId} initialEpisode={animeMeta?.episode} onSelect={selectAnimeMedia} onFallbackDirect={() => setSourceTab('video')} /> : <form onSubmit={addMedia}><label>{sourceTab === 'video' ? '视频地址' : '网页地址'}<input type="url" autoFocus placeholder="https://" value={url} onChange={event => setUrl(event.target.value)} maxLength={4096} required /></label><label>片名 / 标题<input placeholder="今晚的电影" value={title} onChange={event => setTitle(event.target.value)} maxLength={200} /></label><div className="source-help">{sourceTab === 'video' ? '支持 MP4 / HLS（M3U8）。HLS 片源需要允许跨域，临时链接可能过期。' : '仅支持允许嵌入的外部网页，第三方页面内的播放和导航无法自动同步。'}</div><button className="button full">{sourceTab === 'video' ? '开始加载' : '打开网页'}<ArrowUpRight size={17} /></button></form>}</section></div>}
    {roomSettings && <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="room-settings-heading"><button className="modal-close icon-button" aria-label="关闭" onClick={() => setRoomSettings(false)}><X size={20} /></button><h2 id="room-settings-heading">房间设置</h2><p>两个人，一个共同的播放进度。</p><div className="members-list">{room?.members.map(member => <div key={member.clientId}><span className="avatar">{[...member.name][0] || '?'}</span><span>{member.name}{member.clientId === clientId ? '（你）' : ''}</span><small>{member.buffering ? '缓冲中' : member.ready ? '准备好了' : '已连接'}</small></div>)}</div><button className="settings-action" onClick={() => { setRoomSettings(false); setDraftName(name); setJoining(true); }}>修改昵称<ChevronRight size={16} /></button><p className="shortcut-help">电脑快捷键：空格播放 / 暂停，左右方向键跳转，F 全屏。手机轻触显隐控件，双击播放 / 暂停，左右滑动预览进度。</p><p className="source-help">房间创建后 24 小时过期。邀请链接包含入房权限，请只发给一起看的朋友。</p></section></div>}
  </div>;
}

function SeatIllustration() {
  return <svg className="seat-drawing" viewBox="0 0 96 80" fill="none" aria-hidden="true" strokeLinecap="round" strokeLinejoin="round"><path className="seat-back" d="M25 39 24 23c-1-9 5-13 14-12l20-1c10-1 15 4 14 13l-1 16" /><path className="seat-cushion" d="M23 34c-5-1-8 2-7 8l2 13c1 5 4 7 9 7l43 1c6 0 9-3 9-8l1-14c0-5-4-8-8-6l-3 13-41-1Z" /><path className="seat-stitch" d="M30 23c8-1 20 1 35-1M30 53c12 1 23-1 36 0M25 64l-2 7m47-7 2 7" /><path className="seat-ground" d="M12 74c23-2 46 1 73-1" /></svg>;
}
