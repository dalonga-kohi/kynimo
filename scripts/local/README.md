# Kynimo local server

On Windows, testers can use the installer instead: see [apps/desktop](../../apps/desktop/README.md).

Extract the entire archive to a folder you can access. The archive includes Node.js, pinned
Chromium, FFmpeg, FFprobe and the Kynimo engine.

On Windows, open `kynimo.cmd` or run it from PowerShell:

```powershell
.\kynimo.cmd
```

On macOS and Linux, open a terminal in the extracted folder:

```sh
./kynimo
```

Keep the terminal open. Connect your local MCP client's Streamable HTTP transport to
`http://127.0.0.1:8787/mcp`. Stop Kynimo with Ctrl+C. Run with `--port 8788` to change
the port, or `--help` to see all options. The server prints the chosen endpoint and data
directory at startup.

For clients configured to launch a stdio server, use absolute paths to the bundled Node
binary and the launcher script. This works even when the client starts in a different folder.

```json
{
  "mcpServers": {
    "kynimo": {
      "command": "C:\\Apps\\Kynimo\\runtime\\node.exe",
      "args": ["C:\\Apps\\Kynimo\\launch.mjs", "--stdio"]
    }
  }
}
```

On macOS or Linux, use `/path/to/kynimo/runtime/node` and `/path/to/kynimo/launch.mjs`.
Use one server process per data directory. To connect several clients to the same projects,
start one HTTP server and point the clients at it. HTTP grants other processes on the machine
access to the same local account.

Projects, assets and exports are stored in your user data directory:

| Platform | Default directory                                  |
| -------- | -------------------------------------------------- |
| Windows  | `%LOCALAPPDATA%\Kynimo`                            |
| macOS    | `~/Library/Application Support/Kynimo`             |
| Linux    | `$XDG_DATA_HOME/kynimo` or `~/.local/share/kynimo` |

Use `--dir /path/to/data` to choose a different folder. Export files expire after up to
24 hours. Copy a finished export somewhere else to keep it. HTTP returns loopback download
and playback URLs. Stdio returns the local export path.

Kynimo needs no account or network access at runtime. An MCP client running on your machine
can connect even if the model it uses runs elsewhere. The client can send tool inputs and
outputs to its model provider. A connector running solely on a remote service cannot reach
your machine's loopback address.

Linux builds target glibc Linux and require the OS libraries used by Chromium (such as NSS,
GBM and ALSA). On a supported Ubuntu or Debian system, install missing libraries from the
extracted folder with:

```sh
./runtime/node ./app/node_modules/playwright/cli.js install-deps chromium
```

The packaging workflow tests on Ubuntu 24.04. The native Windows build targets x64.

Third-party notices are included alongside the bundled programs and libraries.
