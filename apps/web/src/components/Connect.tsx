"use client";

import { motion } from "motion/react";
import { useId, useState } from "react";
import { MCP_TOOLS, MCP_URL, MCP_URL_PLACEHOLDER } from "@/lib/site";

const url = MCP_URL ?? MCP_URL_PLACEHOLDER;

const CLIENTS = [
  {
    id: "claude-code",
    name: "Claude Code",
    file: "Terminal",
    code: `claude mcp add --transport http kynimo ${url}`,
  },
  {
    id: "cursor",
    name: "Cursor",
    file: ".cursor/mcp.json",
    code: `{
  "mcpServers": {
    "kynimo": { "url": "${url}" }
  }
}`,
  },
  {
    id: "any",
    name: "Any MCP client",
    file: "Remote server · Streamable HTTP · OAuth",
    code: url,
  },
] as const;

const STEPS = [
  ["Add the server", "One line in Claude Code, Cursor or any other MCP client."],
  ["Sign in", "OAuth in your browser. No API keys to paste."],
  ["Ask for a video", "Frames come back into the same chat, so your assistant sees what it made."],
] as const;

export function Connect() {
  const [active, setActive] = useState(0);
  const [copied, setCopied] = useState(false);
  const tabsId = useId();
  const client = CLIENTS[active] ?? CLIENTS[0];

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(client.code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard can be blocked; the text is selectable either way.
    }
  };

  return (
    <div className="connect">
      <div className="snippet">
        <div className="tabs" role="tablist" aria-label="MCP client">
          {CLIENTS.map((c, i) => (
            <button
              key={c.id}
              type="button"
              role="tab"
              id={`${tabsId}-${c.id}`}
              aria-selected={i === active}
              aria-controls={`${tabsId}-panel`}
              tabIndex={i === active ? 0 : -1}
              className="tab"
              onClick={() => setActive(i)}
              onKeyDown={(e) => {
                const dir = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
                if (!dir) return;
                const next = (i + dir + CLIENTS.length) % CLIENTS.length;
                setActive(next);
                document.getElementById(`${tabsId}-${CLIENTS[next]?.id}`)?.focus();
              }}
            >
              {c.name}
              {i === active && (
                <motion.span
                  layoutId={`${tabsId}-underline`}
                  className="tab-underline"
                  transition={{ type: "spring", bounce: 0, duration: 0.35 }}
                />
              )}
            </button>
          ))}
        </div>
        <div
          className="snippet-body"
          role="tabpanel"
          id={`${tabsId}-panel`}
          aria-labelledby={`${tabsId}-${client.id}`}
        >
          <div className="snippet-head">
            <span>{client.file}</span>
            {MCP_URL ? (
              <button type="button" className="copy" onClick={copy} data-copied={copied}>
                {copied ? "Copied" : "Copy"}
              </button>
            ) : (
              <span className="chip">Endpoint opens with the private beta</span>
            )}
          </div>
          <pre>
            <code>{client.code}</code>
          </pre>
        </div>
      </div>

      <ol className="steps">
        {STEPS.map(([title, body]) => (
          <li key={title}>
            <h3>{title}</h3>
            <p>{body}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Every tool the server registers today, scrolling past. Real names, in their real order. */
export function ToolTicker() {
  const row = (hidden: boolean) => (
    <ul aria-hidden={hidden || undefined}>
      {MCP_TOOLS.map((tool) => (
        <li key={tool}>
          <code>{tool}</code>
        </li>
      ))}
    </ul>
  );
  return (
    <div className="ticker">
      <p className="ticker-label">{MCP_TOOLS.length} tools on the server today</p>
      <div className="ticker-window">
        <div className="ticker-move">
          {row(false)}
          {row(true)}
        </div>
      </div>
    </div>
  );
}
