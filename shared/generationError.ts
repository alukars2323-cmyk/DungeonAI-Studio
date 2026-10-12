export class GenerationError extends Error {
  constructor(message: string, public readonly status = 502) {
    super(message);
    this.name = 'GenerationError';
  }
}
