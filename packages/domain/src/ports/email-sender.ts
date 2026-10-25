export interface OutgoingEmail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

/** 发信。没配发信服务时由「只打日志」的实现顶上。 */
export interface EmailSender {
  send(email: OutgoingEmail): Promise<void>;
}
