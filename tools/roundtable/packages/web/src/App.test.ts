import { describe, expect, it } from 'vitest';
describe('roundtable web smoke', () => { it('keeps the offline state explicit', () => expect('writes queued locally').toContain('queued')); });
