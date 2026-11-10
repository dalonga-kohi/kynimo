"use client";

import { motion } from "motion/react";
import { useEffect, useId, useRef, useState } from "react";
import { MCP_URL, MCP_URL_PLACEHOLDER } from "@/lib/site";

const url = MCP_URL ?? MCP_URL_PLACEHOLDER;

const CLIENTS = [
  {
    id: "claude-code",
    name: "Claude Code",
    where: "Terminal",
    code: `claude mcp add --transport http kynimo ${url}`,
  },
  {
    id: "cursor",
    name: "Cursor",
    where: ".cursor/mcp.json",
    code: `{ "mcpServers": { "kynimo": { "url": "${url}" } } }`,
  },
  {
    id: "any",
    name: "Any MCP client",
    where: "Server URL · Streamable HTTP · OAuth",
    code: url,
  },
] as const;

function CopyIcon({ done }: { done: boolean }) {
  return (
    <svg className="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true">
      {done ? (
        <path d="m3.5 8.5 3 3 6-7" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <>
          <rect x="5.25" y="5.25" width="8" height="8" rx="1.75" strokeWidth="1.4" />
          <path
            d="M10.75 3.25v-.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h.5"
            strokeWidth="1.4"
          />
        </>
      )}
    </svg>
  );
}

export function Connect() {
  const [active, setActive] = useState(0);
  const [copied, setCopied] = useState(false);
  const timer = useRef(0);
  const tabsId = useId();
  const client = CLIENTS[active] ?? CLIENTS[0];

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(client.code);
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard can be blocked; the text stays selectable.
    }
  };

  return (
    <div className="connect">
      <div className="clients" role="tablist" aria-label="MCP client">
        {CLIENTS.map((c, i) => (
          <button
            key={c.id}
            type="button"
            role="tab"
            id={`${tabsId}-${c.id}`}
            aria-selected={i === active}
            aria-controls={`${tabsId}-panel`}
            tabIndex={i === active ? 0 : -1}
            className="client"
            onClick={() => {
              setActive(i);
              setCopied(false);
            }}
            onKeyDown={(e) => {
              const dir = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
              if (!dir) return;
              const next = (i + dir + CLIENTS.length) % CLIENTS.length;
              setActive(next);
              setCopied(false);
              document.getElementById(`${tabsId}-${CLIENTS[next]?.id}`)?.focus();
            }}
          >
            {i === active && (
              <motion.span
                layoutId={`${tabsId}-pill`}
                className="client-pill"
                transition={{ type: "spring", bounce: 0, duration: 0.35 }}
              />
            )}
            <span>{c.name}</span>
          </button>
        ))}
      </div>

      <div
        className="command"
        role="tabpanel"
        id={`${tabsId}-panel`}
        aria-labelledby={`${tabsId}-${client.id}`}
      >
        <span className="command-where">{client.where}</span>
        <pre>
          <code>{client.code}</code>
        </pre>
        <button
          type="button"
          className="copy"
          onClick={copy}
          data-copied={copied}
          aria-label={copied ? "Copied" : `Copy the ${client.name} snippet`}
        >
          <CopyIcon done={copied} />
          <span aria-hidden="true">{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      {!MCP_URL && (
        <p className="connect-note">
          The hosted endpoint opens with the private beta. Until then the address is a placeholder.
        </p>
      )}
    </div>
  );
}
