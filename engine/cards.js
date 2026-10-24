// @ts-check

/** @typedef {{ rank: number, suit: 'S' | 'H' | 'D' | 'C' }} Card  rank: 1 = A … 11 = J, 12 = Q, 13 = K */
/** @typedef {'peekOwn' | 'peekOther' | 'swap' | 'king'} PowerKind */

/** @type {Card['suit'][]} */
export const SUITS = ['S', 'H', 'D', 'C'];

/** @returns {Card[]} */
export function newDeck() {
  const deck = [];
  for (const suit of SUITS) for (let rank = 1; rank <= 13; rank++) deck.push({ rank, suit });
  return deck;
}

/** @param {Card} c */
export const isRed = (c) => c.suit === 'H' || c.suit === 'D';

/** @param {Card} c */
export const value = (c) => (c.rank === 13 && isRed(c) ? -1 : c.rank);

/** @param {Card} c @returns {PowerKind | null} */
export function powerOf(c) {
  if (c.rank === 7 || c.rank === 8) return 'peekOwn';
  if (c.rank === 9 || c.rank === 10) return 'peekOther';
  if (c.rank === 11 || c.rank === 12) return 'swap';
  if (c.rank === 13 && !isRed(c)) return 'king';
  return null;
}

const RANK_LABELS = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
/** @param {Card} c */
export const label = (c) => RANK_LABELS[c.rank] + c.suit;
