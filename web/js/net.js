// @ts-check
// WebSocket to one room, with automatic reconnect. The server sends a full snapshot on
// every (re)connect, so a dropped connection costs nothing but a moment.

export class RoomConn {
  /**
   * @param {string} code
   * @param {(msg: any) => void} onMessage
   * @param {(status: 'open' | 'reconnecting') => void} [onStatus]
   */
  constructor(code, onMessage, onStatus = () => {}) {
    this.code = code;
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.closed = false;
    this.retry = 0;
    /** @type {WebSocket | null} */
    this.ws = null;
    /** @type {string[]} */
    this.queue = [];
    this.onVisible = () => {
      if (document.visibilityState === 'visible' && this.ws?.readyState !== WebSocket.OPEN) this.connect();
    };
    document.addEventListener('visibilitychange', this.onVisible);
    this.connect();
  }

  connect() {
    if (this.closed) return;
    this.ws?.close();
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = (this.ws = new WebSocket(`${proto}//${location.host}/api/rooms/${this.code}/ws`));
    ws.onopen = () => {
      this.retry = 0;
      this.onStatus('open');
      for (const m of this.queue.splice(0)) ws.send(m);
    };
    ws.onmessage = (e) => {
      try { this.onMessage(JSON.parse(e.data)); } catch (err) { console.error(err); }
    };
    ws.onclose = (e) => {
      if (ws !== this.ws || this.closed) return;
      if (e.code >= 4000 && e.code < 4100) return; // refused / kicked / left: don't come back
      this.onStatus('reconnecting');
      const ms = Math.min(5000, 300 * 2 ** this.retry++);
      setTimeout(() => this.connect(), ms);
    };
  }

  /** @param {object} msg */
  send(msg) {
    const s = JSON.stringify(msg);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(s);
    else this.queue.push(s);
  }

  close() {
    this.closed = true;
    document.removeEventListener('visibilitychange', this.onVisible);
    this.ws?.close();
  }
}
