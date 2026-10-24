// @ts-check
// The "how to play" sheet, shown before a game and from the ? button.

const HTML = `
  <h2>How to play</h2>
  <ol class="steps">
    <li><b>Lowest total wins.</b> A = 1, 2–10 face value, J 11, Q 12, K 13, <span class="redk">red K = −1</span>.</li>
    <li><b>Start:</b> shuffle your 4 cards if you like, then you see your <b>bottom two</b> for 5 seconds. Remember them.</li>
    <li><b>Your turn:</b> tap the deck to draw. Then tap one of your cards to swap it in, or tap the pile to discard.</li>
    <li><b>Powers</b> (only when you discard a card you just drew):
      <div class="powers"><span>7 8 <i>peek yours</i></span><span>9 10 <i>spy theirs</i></span><span>J Q <i>blind swap</i></span><span>♠♣ K <i>look &amp; swap</i></span></div></li>
    <li><b>Throw!</b> When a card lands on the pile, anyone can throw a card of the same rank: <b>double-tap it</b>, tap it then <b>Throw</b>, or drag it onto the pile. The first correct thrower claims the pile and may throw <b>more cards of that rank</b> (theirs or anyone's).
      <ul>
        <li>Wrong own card: everyone sees it and you lose a turn.</li>
        <li>Right rank but someone claimed it first: your card is shown to all, and they may throw it.</li>
        <li>Right card of someone else: give them one of yours.</li>
        <li>Wrong card of someone else: you take a penalty card.</li>
        <li>No throwing while you hold a drawn card.</li>
      </ul></li>
    <li><b>CABO:</b> at the start of your turn, call it if you think you're lowest. Everyone else gets one more turn, and your cards are locked.</li>
  </ol>`;

/** @param {{ button?: string, onClose?: () => void }} [opts] */
export function showHowTo({ button = 'Got it', onClose } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'modal';
  wrap.innerHTML = `<div class="sheet howto">${HTML}<button class="primary wide">${button}</button></div>`;
  document.body.appendChild(wrap);
  const close = () => {
    wrap.remove();
    onClose?.();
  };
  /** @type {HTMLElement} */ (wrap.querySelector('button')).onclick = close;
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
}
