import * as vscode from 'vscode';

/** Lazily-created output channel used for diagnostics (View -> Output -> LPilot). */
export class Logger {
  private channel?: vscode.OutputChannel;

  constructor(private readonly name = 'LPilot') { }

  private getChannel(): vscode.OutputChannel {
    if (!this.channel) {
      this.channel = vscode.window.createOutputChannel(this.name);
    }
    return this.channel;
  }

  log(level: 'info' | 'warn' | 'error', message: string): void {
    const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}`;
    try {
      this.getChannel().appendLine(line);
    } catch {
      // logging must never break the extension
    }
  }

  info(message: string): void {
    this.log('info', message);
  }

  warn(message: string): void {
    this.log('warn', message);
  }

  error(message: string): void {
    this.log('error', message);
  }

  show(): void {
    this.getChannel().show(true);
  }

  dispose(): void {
    this.channel?.dispose();
    this.channel = undefined;
  }
}
