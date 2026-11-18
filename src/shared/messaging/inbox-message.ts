import { InvariantViolationError } from "../domain/domain-error.ts";

export interface ReceiveInboxProps {
  readonly messageId: string;
  readonly consumerName: string;
  readonly payloadHash: string;
  readonly receivedAt: Date;
}

export interface InboxMessageState extends ReceiveInboxProps {
  readonly processedAt: Date | undefined;
}

/**
 * Registro persistente de uma mensagem recebida por um consumer, chave `(consumerName,
 * messageId)`. É gravado na mesma transação SQL do efeito da mensagem; por isso uma
 * redelivery depois do commit encontra o registro e não repete o efeito.
 */
export class InboxMessage {
  private constructor(
    readonly messageId: string,
    readonly consumerName: string,
    readonly payloadHash: string,
    readonly receivedAt: Date,
    private _processedAt: Date | undefined,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    if (!props.messageId || !props.consumerName || !props.payloadHash) {
      throw new InvariantViolationError("inbox message requires messageId, consumerName and hash");
    }
    return new InboxMessage(
      props.messageId,
      props.consumerName,
      props.payloadHash,
      props.receivedAt,
      undefined,
    );
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      state.receivedAt,
      state.processedAt,
    );
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  /** Mesmo `messageId` com corpo diferente não é redelivery: é mensagem corrompida/forjada. */
  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  markProcessed(at: Date): void {
    if (this._processedAt !== undefined) {
      throw new InvariantViolationError(`inbox message ${this.messageId} already processed`);
    }
    this._processedAt = at;
  }

  toState(): InboxMessageState {
    return {
      messageId: this.messageId,
      consumerName: this.consumerName,
      payloadHash: this.payloadHash,
      receivedAt: this.receivedAt,
      processedAt: this._processedAt,
    };
  }
}
