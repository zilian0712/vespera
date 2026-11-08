import { findReaction } from './reactions';

export default function ReactionContent({ text }: { text: string }) {
  const reaction = findReaction(text);
  return reaction ? <img className="reaction-image" src={reaction.image} alt={reaction.label} draggable={false} /> : <>{text}</>;
}
