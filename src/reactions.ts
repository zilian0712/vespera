import laugh from './assets/reactions/laugh.webp';
import surprised from './assets/reactions/surprised.webp';
import love from './assets/reactions/love.webp';
import clap from './assets/reactions/clap.webp';
import hug from './assets/reactions/hug.webp';
import wait from './assets/reactions/wait.webp';
import sleepy from './assets/reactions/sleepy.webp';
import quiet from './assets/reactions/quiet.webp';
import moved from './assets/reactions/moved.webp';
import cheer from './assets/reactions/cheer.webp';
import scared from './assets/reactions/scared.webp';
import nice from './assets/reactions/nice.webp';

export const reactions = [
  { id: 'laugh', label: '笑哭了', image: laugh },
  { id: 'surprised', label: '惊到了', image: surprised },
  { id: 'love', label: '喜欢这一幕', image: love },
  { id: 'clap', label: '为你鼓掌', image: clap },
  { id: 'hug', label: '抱抱你', image: hug },
  { id: 'wait', label: '等等我', image: wait },
  { id: 'sleepy', label: '有点困了', image: sleepy },
  { id: 'quiet', label: '安静看一会', image: quiet },
  { id: 'moved', label: '太感动了', image: moved },
  { id: 'cheer', label: '好耶', image: cheer },
  { id: 'scared', label: '有点害怕', image: scared },
  { id: 'nice', label: '真不错', image: nice },
] as const;

export function reactionText(id: typeof reactions[number]['id']) {
  return `[芝麻表情:${id}]`;
}

export function findReaction(text: string) {
  return reactions.find(reaction => reactionText(reaction.id) === text);
}
