// 24 kHz mono PCM. End a turn after one second of silence. Keep a short lead-in
// so the first consonant survives the speech threshold. Keep each turn bounded.
export class FeedbackTurnBuffer {
  private chunks: Uint8Array[] = [];
  private lead: Uint8Array[] = [];
  private bytes = 0;
  private silentBytes = 0;
  private talking = false;
  constructor(private readonly onTurn: (audio: Uint8Array) => void, private readonly onSpeech: () => void) {}
  push(data: Uint8Array) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let energy = 0;
    for (let i = 0; i + 1 < data.length; i += 2) energy += (view.getInt16(i, true) / 32768) ** 2;
    const speech = data.length > 0 && Math.sqrt(energy / (data.length / 2)) > 0.025;
    if (speech && !this.talking) {
      this.talking = true; this.onSpeech(); this.chunks = this.lead; this.lead = [];
      this.bytes = this.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    }
    if (!this.talking) { this.lead.push(data.slice()); if (this.lead.length > 2) this.lead.shift(); return; }
    this.chunks.push(data.slice()); this.bytes += data.length;
    this.silentBytes = speech ? 0 : this.silentBytes + data.length;
    if (this.silentBytes >= 48_000 || this.bytes >= 60 * 48_000) this.flush();
  }
  flush() {
    if (!this.talking || !this.bytes) return;
    const pcm = new Uint8Array(this.bytes);
    let offset = 0;
    for (const chunk of this.chunks) { pcm.set(chunk, offset); offset += chunk.length; }
    this.chunks = []; this.lead = []; this.bytes = 0; this.silentBytes = 0; this.talking = false;
    const wav = new Uint8Array(44 + pcm.length);
    const view = new DataView(wav.buffer);
    const ascii = (at: number, value: string) => [...value].forEach((char, index) => view.setUint8(at + index, char.charCodeAt(0)));
    ascii(0, "RIFF"); view.setUint32(4, 36 + pcm.length, true); ascii(8, "WAVEfmt ");
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, 24_000, true); view.setUint32(28, 48_000, true); view.setUint16(32, 2, true);
    view.setUint16(34, 16, true); ascii(36, "data"); view.setUint32(40, pcm.length, true); wav.set(pcm, 44);
    this.onTurn(wav);
  }
}
