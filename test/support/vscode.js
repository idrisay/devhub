// The slice of the VS Code API the Hub and the tree views actually touch.
//
// The behaviour suite drives the real classes rather than reimplementing their
// logic, which is the only way to test the thing that kept going wrong: what a
// view puts on screen while a refresh is in flight. Everything here is the
// smallest stand-in that lets those classes run under plain node.
class EventEmitter {
  constructor() {
    this.listeners = [];
  }
  get event() {
    return (fn) => {
      this.listeners.push(fn);
      return { dispose: () => {} };
    };
  }
  fire(value) {
    this.listeners.forEach((fn) => fn(value));
  }
  dispose() {
    this.listeners = [];
  }
}

class CancellationTokenSource {
  constructor() {
    this.cancelled = false;
    this.handlers = [];
    const self = this;
    this.token = {
      get isCancellationRequested() {
        return self.cancelled;
      },
      onCancellationRequested: (fn) => {
        self.handlers.push(fn);
        return { dispose: () => {} };
      }
    };
  }
  cancel() {
    this.cancelled = true;
    this.handlers.forEach((fn) => fn());
  }
  dispose() {}
}

class TreeItem {
  constructor(label, collapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}
class ThemeIcon {
  constructor(id, color) {
    this.id = id;
    this.color = color;
  }
}
class ThemeColor {
  constructor(id) {
    this.id = id;
  }
}
class MarkdownString {
  constructor(value = '') {
    this.value = value;
  }
  appendMarkdown(value) {
    this.value += value;
    return this;
  }
}
class Range {
  constructor(...args) {
    this.args = args;
  }
}

/** Settings the suite can write to, read back through `workspace.getConfiguration`. */
const settings = {};

module.exports = {
  EventEmitter,
  CancellationTokenSource,
  TreeItem,
  ThemeIcon,
  ThemeColor,
  MarkdownString,
  Range,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  Uri: {
    joinPath: (...parts) => ({ fsPath: parts.join('/'), toString: () => parts.join('/') }),
    file: (fsPath) => ({ fsPath }),
    parse: (value) => ({ toString: () => value })
  },
  workspace: {
    getConfiguration: () => ({
      get: (key, fallback) => (key in settings ? settings[key] : fallback)
    }),
    onDidChangeConfiguration: () => ({ dispose: () => {} }),
    fs: {}
  },
  window: {
    activeTextEditor: undefined,
    createOutputChannel: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      appendLine: () => {},
      show: () => {},
      dispose: () => {}
    })
  },
  commands: { executeCommand: async () => undefined },
  extensions: { getExtension: () => undefined },
  settings
};
