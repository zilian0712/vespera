import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowUpRight, ChevronLeft, ChevronRight, RefreshCw, Search, Sparkles, Tv } from 'lucide-react';
import {
  buildAnimeMediaMeta, fetchAnimeDetail, fetchAnimeLatest, fetchAnimeList,
  fetchAnimeSearch, fetchAnimeTags, fetchAnimeVod, selectPlayableVodLines,
  type AnimeDetailBundle, type AnimeEpisode, type AnimeLatestItem,
  type AnimeListItem, type AnimeTag, type AnimeVodLine,
} from './anime';
import type { AnimeMediaMeta } from './room';

export type SelectedAnimeMedia = {
  url: string;
  title: string;
  anime: AnimeMediaMeta;
};

type Props = {
  connected: boolean;
  initialBangumiId?: number;
  initialEpisode?: number;
  onSelect: (media: SelectedAnimeMedia) => void;
  onFallbackDirect: () => void;
};

export default function AnimeBrowser({
  connected, initialBangumiId, initialEpisode, onSelect, onFallbackDirect,
}: Props) {
  const [mode, setMode] = useState<'latest' | 'catalog' | 'search'>('latest');
  const [keyword, setKeyword] = useState('');
  const [submittedKeyword, setSubmittedKeyword] = useState('');
  const [genre, setGenre] = useState('');
  const [skip, setSkip] = useState(0);
  const [tags, setTags] = useState<AnimeTag[]>([]);
  const [latestItems, setLatestItems] = useState<AnimeLatestItem[]>([]);
  const [listItems, setListItems] = useState<AnimeListItem[]>([]);
  const [hasPrev, setHasPrev] = useState(false);
  const [hasNext, setHasNext] = useState(false);
  const [loadingList, setLoadingList] = useState(false);
  const [listError, setListError] = useState('');
  const [reloadToken, setReloadToken] = useState(0);

  const [selectedId, setSelectedId] = useState<number | null>(initialBangumiId ?? null);
  const [bundle, setBundle] = useState<AnimeDetailBundle | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState('');

  const [activeEpisode, setActiveEpisode] = useState<AnimeEpisode | null>(null);
  const [lines, setLines] = useState<AnimeVodLine[]>([]);
  const [selectedLineIndex, setSelectedLineIndex] = useState(0);
  const [loadingVod, setLoadingVod] = useState(false);
  const [vodError, setVodError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    fetchAnimeTags('genre', 0, controller.signal)
      .then(items => setTags(items.slice(0, 10)))
      .catch(() => {
        // Optional genre tags; ignore failure.
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (selectedId !== null) return;
    const controller = new AbortController();
    setLoadingList(true);
    setListError('');

    const run = async () => {
      try {
        if (mode === 'latest') {
          const items = await fetchAnimeLatest(controller.signal);
          setLatestItems(items);
          setHasPrev(false);
          setHasNext(false);
        } else if (mode === 'search' && submittedKeyword) {
          const res = await fetchAnimeSearch(submittedKeyword, skip, controller.signal);
          setListItems(res.items);
          setHasPrev(res.prev);
          setHasNext(res.next);
        } else {
          const res = await fetchAnimeList({ skip, genre: genre || undefined }, controller.signal);
          setListItems(res.items);
          setHasPrev(res.prev);
          setHasNext(res.next);
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        setListError(err instanceof Error ? err.message : '番剧列表加载失败');
      } finally {
        if (!controller.signal.aborted) setLoadingList(false);
      }
    };
    void run();
    return () => controller.abort();
  }, [mode, submittedKeyword, genre, skip, selectedId, reloadToken]);

  const loadVodForEpisode = useCallback(async (bangumiId: number, ep: AnimeEpisode, signal?: AbortSignal) => {
    setActiveEpisode(ep);
    setLines([]);
    setSelectedLineIndex(0);
    setVodError('');
    setLoadingVod(true);
    try {
      const rawLines = await fetchAnimeVod(bangumiId, ep.episode, signal);
      const playable = selectPlayableVodLines(rawLines);
      setLines(playable);
      if (!playable.length) {
        setVodError(rawLines.length ? '该集暂无支持 HTTPS 直接播放的线路，请尝试其他集数' : '暂未获取到该集播放线路');
      }
    } catch (err) {
      if (signal?.aborted) return;
      setVodError(err instanceof Error ? err.message : '播放线路解析失败');
    } finally {
      if (!signal?.aborted) setLoadingVod(false);
    }
  }, []);

  useEffect(() => {
    if (selectedId === null) {
      setBundle(null);
      setActiveEpisode(null);
      setLines([]);
      return;
    }
    const controller = new AbortController();
    setLoadingDetail(true);
    setDetailError('');
    setBundle(null);
    setActiveEpisode(null);
    setLines([]);
    setVodError('');

    fetchAnimeDetail(selectedId, controller.signal)
      .then(data => {
        setBundle(data);
        const preferred = (initialBangumiId === selectedId && initialEpisode
          ? data.episodes.find(item => item.episode === initialEpisode)
          : undefined) || data.episodes[0] || null;
        if (preferred) {
          void loadVodForEpisode(selectedId, preferred, controller.signal);
        }
      })
      .catch(err => {
        if (controller.signal.aborted) return;
        setDetailError(err instanceof Error ? err.message : '番剧详情加载失败');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingDetail(false);
      });

    return () => controller.abort();
  }, [selectedId, initialBangumiId, initialEpisode, loadVodForEpisode]);

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    const trimmed = keyword.trim();
    if (!trimmed) {
      setMode('latest');
      setSubmittedKeyword('');
      setSkip(0);
      return;
    }
    setSelectedId(null);
    setMode('search');
    setSubmittedKeyword(trimmed);
    setSkip(0);
  }

  function applySelection() {
    if (!bundle || !activeEpisode) return;
    const chosen = lines[selectedLineIndex];
    if (!chosen) return;
    const epPart = activeEpisode.title?.trim()
      ? `第 ${activeEpisode.episode} 话 · ${activeEpisode.title.trim()}`
      : `第 ${activeEpisode.episode} 话`;
    const fullTitle = `${bundle.detail.title} ${epPart}`.slice(0, 200);
    onSelect({
      url: chosen.url,
      title: fullTitle,
      anime: buildAnimeMediaMeta(bundle.detail, activeEpisode, chosen.caption || chosen.type, bundle.episodes.length),
    });
  }

  if (selectedId !== null) {
    const chosenLine = lines[selectedLineIndex];
    const score = bundle?.detail.rating[0]?.score;
    return (
      <div className="anime-detail-panel">
        <div className="anime-detail-nav">
          <button type="button" className="anime-back" onClick={() => setSelectedId(null)}>
            <ArrowLeft size={16} />返回番剧列表
          </button>
          {bundle?.detail.status && <span className="anime-status-pill">{bundle.detail.status}</span>}
        </div>

        {loadingDetail && (
          <div className="anime-state">
            <span className="spinner anime-spinner" />
            <p>正在读取番剧与分集信息…</p>
          </div>
        )}

        {detailError && !loadingDetail && (
          <div className="anime-state anime-state-error" role="alert">
            <p>{detailError}</p>
            <div className="anime-state-actions">
              <button type="button" onClick={() => setSelectedId(selectedId)}><RefreshCw size={14} />重试</button>
              <button type="button" onClick={onFallbackDirect}>改用视频直链</button>
            </div>
          </div>
        )}

        {bundle && !loadingDetail && (
          <>
            <div className="anime-hero">
              {bundle.detail.image ? (
                <img className="anime-cover" src={bundle.detail.image} alt="" loading="lazy" referrerPolicy="no-referrer" />
              ) : (
                <div className="anime-cover anime-cover-placeholder"><Tv size={24} /></div>
              )}
              <div className="anime-meta">
                <h3>{bundle.detail.title}</h3>
                <div className="anime-badges">
                  {Boolean(score && score > 0) && <span className="anime-score">★ {score?.toFixed(1)}</span>}
                  {bundle.detail.genres.slice(0, 4).map(g => <span key={g}>{g}</span>)}
                </div>
                {bundle.detail.overview && <p className="anime-overview">{bundle.detail.overview}</p>}
              </div>
            </div>

            {bundle.related.length > 0 && (
              <div className="anime-related">
                <span>关联条目</span>
                <div>
                  {bundle.related.slice(0, 6).map(rel => (
                    <button key={rel.id} type="button" onClick={() => setSelectedId(rel.id)}>
                      {rel.relation ? `${rel.relation} · ` : ''}{rel.title}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="anime-section">
              <div className="anime-section-head">
                <strong>选择集数</strong>
                <span>{bundle.episodes.length ? `共 ${bundle.episodes.length} 话` : '暂无分集'}</span>
              </div>
              {bundle.episodes.length > 0 ? (
                <div className="anime-episodes">
                  {bundle.episodes.map(ep => (
                    <button
                      key={ep.episode}
                      type="button"
                      className={activeEpisode?.episode === ep.episode ? 'selected' : ''}
                      title={ep.title || `第 ${ep.episode} 话`}
                      onClick={() => void loadVodForEpisode(bundle.detail.id, ep)}
                    >
                      {ep.episode}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="source-help">该番剧暂未收录可播分集，请尝试其他条目或使用视频直链。</p>
              )}
            </div>

            {activeEpisode && (
              <div className="anime-section">
                <div className="anime-section-head">
                  <strong>播放线路 · 第 {activeEpisode.episode} 话</strong>
                  {activeEpisode.title && <span>{activeEpisode.title}</span>}
                </div>
                {loadingVod ? (
                  <div className="anime-inline-loading"><span className="spinner anime-spinner" />正在解析可用线路…</div>
                ) : vodError ? (
                  <p className="anime-inline-error" role="alert">{vodError}</p>
                ) : (
                  <div className="anime-lines">
                    {lines.map((line, idx) => (
                      <button
                        key={`${line.sort}-${idx}`}
                        type="button"
                        className={idx === selectedLineIndex ? 'selected' : ''}
                        onClick={() => setSelectedLineIndex(idx)}
                      >
                        <span>{line.caption || line.type || `线路 ${idx + 1}`}</span>
                        <small>{/\.m3u8(?:$|[?#])/i.test(line.url) ? 'HLS' : /\.mp4(?:$|[?#])/i.test(line.url) ? 'MP4' : '直连'}</small>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="source-help">
              选中后将为双方同步加载同一集，并自动挂载时间轴弹幕（可在播放器弹幕偏好中开关）。
            </div>

            <button
              type="button"
              className="button full"
              disabled={!connected || !chosenLine || loadingVod}
              onClick={applySelection}
            >
              {connected
                ? chosenLine
                  ? `同步放映第 ${activeEpisode?.episode ?? 1} 话`
                  : '请选择可用线路'
                : '等待房间连接…'}
              <ArrowUpRight size={17} />
            </button>
          </>
        )}
      </div>
    );
  }

  const cards = mode === 'latest'
    ? latestItems.map(item => ({
      id: item.id,
      title: item.title,
      image: item.image,
      subtitle: item.status || item.episodeTitle || '最近更新',
    }))
    : listItems.map(item => ({
      id: item.id,
      title: item.title,
      image: item.image,
      subtitle: item.status || item.tagline || (item.episode ? `更新至 ${item.episode} 话` : ''),
    }));

  return (
    <div className="anime-browser">
      <form className="anime-search" onSubmit={submitSearch}>
        <Search size={16} aria-hidden="true" />
        <input
          type="search"
          aria-label="搜索番剧"
          placeholder="搜索番剧名称，例如：芙莉莲、排球少年"
          value={keyword}
          maxLength={80}
          onChange={event => setKeyword(event.target.value)}
        />
        <button type="submit">搜索</button>
      </form>

      <div className="anime-filters" aria-label="番剧分类筛选">
        <button
          type="button"
          className={mode === 'latest' ? 'selected' : ''}
          onClick={() => { setMode('latest'); setGenre(''); setSkip(0); }}
        >
          <Sparkles size={13} />最近更新
        </button>
        <button
          type="button"
          className={mode === 'catalog' && !genre ? 'selected' : ''}
          onClick={() => { setMode('catalog'); setGenre(''); setSkip(0); }}
        >
          全部番剧
        </button>
        {tags.map(tag => (
          <button
            key={tag.name}
            type="button"
            className={mode === 'catalog' && genre === tag.name ? 'selected' : ''}
            onClick={() => { setMode('catalog'); setGenre(tag.name); setSkip(0); }}
          >
            {tag.name}
          </button>
        ))}
      </div>

      {loadingList ? (
        <div className="anime-state">
          <span className="spinner anime-spinner" />
          <p>正在加载番剧目录…</p>
        </div>
      ) : listError ? (
        <div className="anime-state anime-state-error" role="alert">
          <p>{listError}</p>
          <div className="anime-state-actions">
            <button type="button" onClick={() => setReloadToken(value => value + 1)}><RefreshCw size={14} />重新加载</button>
            <button type="button" onClick={onFallbackDirect}>改用视频直链</button>
          </div>
        </div>
      ) : cards.length === 0 ? (
        <div className="anime-state">
          <p>{mode === 'search' ? `未找到与「${submittedKeyword}」相关的番剧` : '暂无番剧条目'}</p>
        </div>
      ) : (
        <>
          <div className="anime-grid">
            {cards.map(card => (
              <button
                key={card.id}
                type="button"
                className="anime-card"
                onClick={() => setSelectedId(card.id)}
              >
                <div className="anime-card-poster">
                  {card.image ? (
                    <img src={card.image} alt="" loading="lazy" referrerPolicy="no-referrer" />
                  ) : (
                    <div className="anime-cover-placeholder"><Tv size={22} /></div>
                  )}
                </div>
                <strong>{card.title}</strong>
                <span>{card.subtitle}</span>
              </button>
            ))}
          </div>

          {(hasPrev || hasNext) && (
            <div className="anime-pagination">
              <button type="button" disabled={!hasPrev} onClick={() => setSkip(value => Math.max(0, value - 20))}>
                <ChevronLeft size={15} />上一页
              </button>
              <span>第 {Math.floor(skip / 20) + 1} 页</span>
              <button type="button" disabled={!hasNext} onClick={() => setSkip(value => value + 20)}>
                下一页<ChevronRight size={15} />
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
