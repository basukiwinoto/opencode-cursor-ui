import * as vscode from "vscode";

/** Standard disposable collection with `dispose()` idempotence. */
export class DisposableStore implements vscode.Disposable {
  private items: vscode.Disposable[] = [];
  private disposed = false;

  add<T extends vscode.Disposable>(item: T): T {
    if (this.disposed) {
      item.dispose();
      return item;
    }
    this.items.push(item);
    return item;
  }

  dispose(): void {
    this.disposed = true;
    for (const item of this.items.splice(0)) {
      try {
        item.dispose();
      } catch {
        // dispose errors are non-fatal
      }
    }
  }
}

export function toDisposable(fn: () => void): vscode.Disposable {
  return { dispose: fn };
}

/** Promise-based sleep that can be aborted. */
export function sleep(ms: number, token?: vscode.CancellationToken): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (token) {
      token.onCancellationRequested(() => {
        clearTimeout(timer);
        reject(new vscode.CancellationError());
      });
    }
  });
}
