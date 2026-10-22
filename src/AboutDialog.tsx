import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowDownToLine,
  BookOpen,
  ExternalLink,
  FolderOpen,
  Layers,
  MessageSquareWarning,
  RefreshCw,
} from "lucide-react";
import { Button, Modal } from "./components";
import { formatSize } from "./presentation";

export type UpdateCheck = {
  checking: boolean;
  current?: string;
  latest?: string;
  newer?: boolean;
  url?: string;
  error?: string;
  notes?: string;
  canInstall?: boolean;
  installBlocked?: string;
};
export type AppUpdate = {
  phase: string;
  received: number;
  total: number;
  error: string;
};

// Inline **bold** and `code` of the changelog; everything else is text.
function inline(text: string): ReactNode[] {
  return text
    .split(/(\*\*[^*]+\*\*|`[^`]+`)/)
    .filter(Boolean)
    .map((part, i) =>
      part.startsWith("**") ? (
        <strong key={i}>{part.slice(2, -2)}</strong>
      ) : part.startsWith("`") ? (
        <code key={i}>{part.slice(1, -1)}</code>
      ) : (
        part
      ),
    );
}

// The changelog / release notes Markdown we write ourselves: "###" groups,
// "-" items with one nested level, paragraphs. Release notes stop before
// their install and checksum sections. Built as elements, never as HTML.
export function ReleaseNotes({ text, label }: { text: string; label: string }) {
  type Item = { text: string; children: string[] };
  const blocks: ReactNode[] = [];
  let items: Item[] = [];
  const flush = () => {
    if (!items.length) return;
    blocks.push(
      <ul key={blocks.length}>
        {items.map((it, i) => (
          <li key={i}>
            {inline(it.text)}
            {it.children.length > 0 && (
              <ul>
                {it.children.map((c, j) => (
                  <li key={j}>{inline(c)}</li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>,
    );
    items = [];
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (/^##\s+(安装|校验)/.test(line)) break;
    if (/^#{1,2}\s/.test(line) || line.startsWith("```")) continue;
    const head = /^###\s+(.*)/.exec(line);
    const sub = /^\s{2,}[-*]\s+(.*)/.exec(line);
    const item = /^[-*]\s+(.*)/.exec(line);
    if (head) {
      flush();
      blocks.push(<h4 key={blocks.length}>{head[1]}</h4>);
    } else if (sub && items.length) items.at(-1)!.children.push(sub[1]);
    else if (item) items.push({ text: item[1], children: [] });
    else if (line.trim()) {
      flush();
      blocks.push(<p key={blocks.length}>{inline(line.trim())}</p>);
    }
  }
  flush();
  // Scrolls on its own, so keyboard users can focus it to scroll.
  return (
    <div
      className="release-notes"
      tabIndex={0}
      role="region"
      aria-label={label}
    >
      {blocks}
    </div>
  );
}

export function AboutDialog({
  open,
  onClose,
  update,
  appUpdate,
  blocked,
  onCheck,
  onDownload,
  onInstall,
  action,
}: {
  open: boolean;
  onClose: () => void;
  update: UpdateCheck;
  appUpdate: AppUpdate;
  // Why installing has to wait (an encode is running), "" when it can go.
  blocked: string;
  onCheck: () => void;
  onDownload: () => void;
  onInstall: () => void;
  action: (name: string, payload?: unknown) => void;
}) {
  const [info, setInfo] = useState<{ version: string; notes: string }>({
    version: __APP_VERSION__,
    notes: "",
  });
  useEffect(() => {
    if (open && window.encoder)
      window.encoder
        .invoke("aboutInfo")
        .then(setInfo)
        .catch(() => {});
  }, [open]);
  const working = ["downloading", "extracting", "installing"].includes(
    appUpdate.phase,
  );
  const status = update.checking
    ? "正在检查更新…"
    : update.error
      ? "检查更新失败：" + update.error
      : update.newer
        ? `发现新版本 ${update.latest}`
        : update.current
          ? update.latest
            ? "已是最新版本"
            : "项目尚未发布版本"
          : "尚未检查更新";
  const tone = update.error ? "danger" : update.newer ? "new" : "";
  return (
    <Modal
      open={open}
      onClose={onClose}
      fixedHeight
      title="关于"
      description="版本与更新、更新日志、作者与支持。"
    >
      <div className="about-hero">
        <span className="brand-icon" aria-hidden="true">
          <Layers size={23} />
        </span>
        <div>
          <p className="about-name">
            MMD<span>Encoder</span>
          </p>
          <p className="about-tagline">让每一帧，恰到好处。</p>
        </div>
        <p className="about-version">
          <span>版本</span>
          <strong>{info.version}</strong>
        </p>
      </div>
      <div className="about-ticks" aria-hidden="true" />

      <section
        className="modal-section"
        aria-label="软件更新"
        aria-busy={update.checking}
      >
        <div className="status-row">
          <p className={`about-status ${tone}`} role="status">
            <span className="status-dot" aria-hidden="true" />
            {status}
          </p>
          <div className="row-actions">
            <Button disabled={update.checking || working} onClick={onCheck}>
              <RefreshCw size={15} />
              检查更新
            </Button>
            {update.newer && update.canInstall && (
              <Button
                variant="primary"
                disabled={working || (appUpdate.phase === "ready" && !!blocked)}
                title={appUpdate.phase === "ready" ? blocked : undefined}
                onClick={appUpdate.phase === "ready" ? onInstall : onDownload}
              >
                <ArrowDownToLine size={15} />
                {appUpdate.phase === "ready"
                  ? "重启并完成更新"
                  : appUpdate.phase === "downloading"
                    ? "正在下载…"
                    : appUpdate.phase === "extracting"
                      ? "正在解压…"
                      : "下载并更新"}
              </Button>
            )}
            <Button
              variant={
                update.newer && !update.canInstall ? "primary" : undefined
              }
              onClick={() =>
                action("openReleasePage", {
                  url: update.newer ? update.url : "",
                })
              }
            >
              <ExternalLink size={15} />
              {update.newer ? "打开下载页" : "项目发行页"}
            </Button>
          </div>
        </div>
        {update.newer && (
          <p
            className={appUpdate.error ? "inline-error" : "hint"}
            role={appUpdate.error ? "alert" : undefined}
          >
            {appUpdate.error
              ? "更新失败：" + appUpdate.error
              : appUpdate.phase === "downloading"
                ? `已下载 ${formatSize(appUpdate.received)}${appUpdate.total ? " / " + formatSize(appUpdate.total) : ""}`
                : appUpdate.phase === "ready"
                  ? blocked ||
                    "新版本已下载并通过校验。点“重启并完成更新”后软件会关闭，替换程序文件后自动重新打开；设置、预设和日志（data 文件夹）保留不动。"
                  : update.canInstall
                    ? "下载后先校验 SHA-256，再替换程序文件；data 文件夹保留不动，替换失败会自动还原旧版本。"
                    : update.installBlocked ||
                      "这个版本没有可自动安装的压缩包，请打开下载页手动更新。"}
          </p>
        )}
      </section>

      <section className="modal-section" aria-label="本版更新日志">
        <div className="status-row">
          <h3>{info.version} 更新内容</h3>
          <Button
            onClick={() => action("openProjectPage", { page: "releases" })}
          >
            <BookOpen size={15} />
            完整发行说明
          </Button>
        </div>
        {info.notes ? (
          <ReleaseNotes text={info.notes} label={`${info.version} 更新内容`} />
        ) : (
          <p className="hint">没有找到这个版本的更新日志。</p>
        )}
      </section>

      <section className="modal-section" aria-label="作者与支持">
        <h3>作者与支持</h3>
        <dl className="about-facts">
          <div>
            <dt>作者</dt>
            <dd>CicloO</dd>
          </div>
          <div>
            <dt>协作</dt>
            <dd>Claude、ChatGPT</dd>
          </div>
          <div>
            <dt>许可证</dt>
            <dd>
              <button
                type="button"
                className="text-link"
                onClick={() => action("openProjectPage", { page: "license" })}
              >
                Mozilla Public License 2.0
              </button>
            </dd>
          </div>
          <div>
            <dt>第三方组件</dt>
            <dd>
              <button
                type="button"
                className="text-link"
                onClick={() => action("openProjectPage", { page: "notices" })}
              >
                FFmpeg、NVEncC、ArtCNN 等的声明
              </button>
            </dd>
          </div>
        </dl>
        <p className="hint">
          遇到问题请在 GitHub
          提交反馈，写明操作步骤，并附上任务的“实际命令与日志”或日志文件夹里的文件。
        </p>
        <div className="row-actions">
          <Button onClick={() => action("openProjectPage", { page: "home" })}>
            <ExternalLink size={15} />
            项目主页
          </Button>
          <Button onClick={() => action("openProjectPage", { page: "issues" })}>
            <MessageSquareWarning size={15} />
            问题反馈
          </Button>
          <Button onClick={() => action("openDataFolder")}>
            <FolderOpen size={15} />
            配置与日志
          </Button>
        </div>
      </section>
    </Modal>
  );
}
