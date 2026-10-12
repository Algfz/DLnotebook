/* =====================================================================
   audio.js — 音频时钟
   核心原则：位置由「音频时钟」算出，绝不用帧时间累加。
   这样掉帧只会让画面卡，绝不会造成音画漂移。
   ===================================================================== */

export class AudioClock {
  constructor(ctx, buffer, latencyMs = 0) {
    this.ctx = ctx;
    this.buffer = buffer;
    this.latency = latencyMs / 1000;
    this.playing = false;
    this.offset = 0;        // 本次播放的起点（秒）
    this.t0 = 0;            // 起播时的 AudioContext 时刻
    this.node = null;
    this.gainNode = null;
    this.volume = 0.8;
  }

  play(offset = 0) {
    this.stop();
    const s = this.ctx.createBufferSource();
    s.buffer = this.buffer;
    const g = this.ctx.createGain();
    g.gain.value = this.volume;
    s.connect(g);
    g.connect(this.ctx.destination);
    s.start(0, Math.max(0, Math.min(offset, this.buffer.duration)));
    this.node = s;
    this.gainNode = g;
    this.t0 = this.ctx.currentTime;
    this.offset = offset;
    this.playing = true;
  }

  stop() {
    if (this.node) { try { this.node.stop(); } catch (e) { /* 已停止 */ } this.node = null; }
    this.playing = false;
  }

  // 未补偿的原始播放位置
  get rawTime() {
    if (!this.playing) return this.offset;
    return this.offset + (this.ctx.currentTime - this.t0);
  }

  // 用户感知时间 = 音频位置 − 延迟补偿
  // 下界取 offset：补偿期内画面停在起点，不会往回倒退
  get time() {
    const raw = this.rawTime;
    return Math.max(this.offset, Math.min(raw - this.latency, this.buffer.duration));
  }

  setLatency(ms) { this.latency = ms / 1000; }
  setVolume(v) {
    this.volume = v;
    if (this.gainNode) this.gainNode.gain.value = v;
  }
  get duration() { return this.buffer.duration; }
}
