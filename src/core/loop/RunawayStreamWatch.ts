/**
 * H3: Runaway Generation Stream Watchdog.
 *
 * Ported from Hermes `agent/repetition_guard.py` (`RepetitionWatch`).
 * Monitors streaming `text_delta` and `thinking_delta` chunks in real time and
 * trips when degenerate token repetition occurs:
 *   1. Single-character run >= 256 identical characters in a row
 *   2. Exact contiguous phrase (length 20..200 chars) repeated >= 10x at the tail
 *   3. 32-char sliding window unique ratio < 0.20 once accumulated length >= 1024 chars
 */

export interface RunawayStreamWatchOptions {
  charRunLimit?: number;
  minPhraseLen?: number;
  maxPhraseLen?: number;
  exactPhraseRepeats?: number;
  minEvalChars?: number;
  windowLen?: number;
  windowStep?: number;
  minUniqueRatio?: number;
}

export interface StreamChannelVerdict {
  tripped: boolean;
  reason: string | null;
  cleanPrefix: string;
}

class ChannelWatch {
  private readonly charRunLimit: number;
  private readonly minPhraseLen: number;
  private readonly maxPhraseLen: number;
  private readonly exactPhraseRepeats: number;
  private readonly minEvalChars: number;
  private readonly windowLen: number;
  private readonly windowStep: number;
  private readonly minUniqueRatio: number;

  private buf = "";
  private lastChar = "";
  private charRun = 0;
  private lastEvaluatedLen = 0;
  private evalInterval = 128;

  public tripped = false;
  public reason: string | null = null;
  public cutIndex: number | null = null;

  constructor(opts: RunawayStreamWatchOptions = {}) {
    this.charRunLimit = opts.charRunLimit ?? 256;
    this.minPhraseLen = opts.minPhraseLen ?? 20;
    this.maxPhraseLen = opts.maxPhraseLen ?? 200;
    this.exactPhraseRepeats = opts.exactPhraseRepeats ?? 10;
    this.minEvalChars = opts.minEvalChars ?? 1024;
    this.windowLen = opts.windowLen ?? 32;
    this.windowStep = opts.windowStep ?? 8;
    this.minUniqueRatio = opts.minUniqueRatio ?? 0.2;
  }

  feed(chunk: string): boolean {
    if (!chunk || this.tripped) return this.tripped;

    const startOffset = this.buf.length;
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i];
      if (ch === this.lastChar) {
        this.charRun += 1;
        if (this.charRun >= this.charRunLimit) {
          this.tripped = true;
          const display = JSON.stringify(ch);
          this.reason = `char_run:${display}x${this.charRun}`;
          // Keep up to the first occurrence of the runaway character run
          this.cutIndex = Math.max(0, startOffset + i + 1 - this.charRun);
          this.buf += chunk;
          return true;
        }
      } else {
        this.lastChar = ch;
        this.charRun = 1;
      }
    }

    this.buf += chunk;
    const n = this.buf.length;
    if (n - this.lastEvaluatedLen < this.evalInterval) {
      return false;
    }
    this.lastEvaluatedLen = n;

    // 2. Contiguous exact phrase repetition at the tail
    const minLoopChars = this.minPhraseLen * this.exactPhraseRepeats;
    if (n >= minLoopChars) {
      const phraseHit = this.checkExactLoop();
      if (phraseHit) {
        this.tripped = true;
        this.reason = phraseHit.reason;
        this.cutIndex = phraseHit.cutIndex;
        return true;
      }
    }

    // 3. Sliding-window diversity collapse
    if (n >= this.minEvalChars) {
      const ratioHit = this.checkUniqueWindowRatio();
      if (ratioHit) {
        this.tripped = true;
        this.reason = ratioHit.reason;
        this.cutIndex = ratioHit.cutIndex;
        return true;
      }
    }

    return false;
  }

  private checkExactLoop(): { reason: string; cutIndex: number } | null {
    const tailLimit = Math.min(
      this.buf.length,
      this.maxPhraseLen * (this.exactPhraseRepeats + 1),
    );
    const tailOffset = this.buf.length - tailLimit;
    const tail = this.buf.slice(tailOffset);
    const maxLen = Math.min(
      this.maxPhraseLen,
      Math.floor(tail.length / this.exactPhraseRepeats),
    );

    for (let pLen = this.minPhraseLen; pLen <= maxLen; pLen++) {
      const phrase = tail.slice(tail.length - pLen);
      if (phrase.trim().length === 0) continue;
      let matched = true;
      for (let k = 2; k <= this.exactPhraseRepeats; k++) {
        const start = tail.length - pLen * k;
        if (start < 0 || tail.slice(start, start + pLen) !== phrase) {
          matched = false;
          break;
        }
      }
      if (matched) {
        const snippet = JSON.stringify(phrase.slice(0, 30));
        // Keep the first occurrence of the phrase and cut the rest of the repeats
        const repeatStartInTail = tail.length - pLen * this.exactPhraseRepeats + pLen;
        return {
          reason: `exact_phrase_loop:len=${pLen},repeats=${this.exactPhraseRepeats},sample=${snippet}`,
          cutIndex: Math.max(0, tailOffset + repeatStartInTail),
        };
      }
    }
    return null;
  }

  private checkUniqueWindowRatio(): { reason: string; cutIndex: number } | null {
    const sample =
      this.buf.length > 4096 ? this.buf.slice(this.buf.length - 4096) : this.buf;
    const sampleOffset = this.buf.length - sample.length;
    const windows: string[] = [];
    for (let i = 0; i <= sample.length - this.windowLen; i += this.windowStep) {
      windows.push(sample.slice(i, i + this.windowLen));
    }
    if (windows.length === 0) return null;
    const uniqueCount = new Set(windows).size;
    const ratio = uniqueCount / windows.length;
    if (ratio < this.minUniqueRatio) {
      // Retain the first unique prefix in the sample
      const seen = new Set<string>();
      let firstDuplicateAt = sample.length;
      for (let i = 0; i <= sample.length - this.windowLen; i += this.windowStep) {
        const win = sample.slice(i, i + this.windowLen);
        if (seen.has(win)) {
          firstDuplicateAt = i;
          break;
        }
        seen.add(win);
      }
      return {
        reason: `low_unique_window_ratio:${ratio.toFixed(3)}<${this.minUniqueRatio}`,
        cutIndex: Math.max(0, sampleOffset + firstDuplicateAt),
      };
    }
    return null;
  }

  cleanPrefix(fullText: string): string {
    if (!this.tripped || this.cutIndex === null) return fullText;
    return fullText.slice(0, Math.min(fullText.length, this.cutIndex));
  }
}

export class RunawayStreamWatch {
  private readonly textWatch: ChannelWatch;
  private readonly thinkingWatch: ChannelWatch;

  constructor(opts: RunawayStreamWatchOptions = {}) {
    this.textWatch = new ChannelWatch(opts);
    this.thinkingWatch = new ChannelWatch(opts);
  }

  feedText(delta: string): boolean {
    return this.textWatch.feed(delta);
  }

  feedThinking(delta: string): boolean {
    return this.thinkingWatch.feed(delta);
  }

  get tripped(): boolean {
    return this.textWatch.tripped || this.thinkingWatch.tripped;
  }

  get reason(): string | null {
    if (this.textWatch.tripped) return `text:${this.textWatch.reason}`;
    if (this.thinkingWatch.tripped) return `thinking:${this.thinkingWatch.reason}`;
    return null;
  }

  cleanText(fullText: string): string {
    return this.textWatch.cleanPrefix(fullText);
  }

  cleanThinking(fullThinking: string): string {
    return this.thinkingWatch.cleanPrefix(fullThinking);
  }
}

export const RUNAWAY_RECOVERY_NUDGE =
  "Your previous response entered a repetitive output loop and was cut off. Please provide a concise final response without repeating yourself.";
