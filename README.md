# Usage & Conversations Monitor for Claude Code

See your Claude subscription limits and the state of your Claude Code conversations from the VS Code status bar.

> Unofficial community extension, not affiliated with or endorsed by Anthropic.

## What it shows

Two items on the right side of the status bar:

| Item | Text | Hover | Click |
|---|---|---|---|
| **Conversations** | `⟳ 2` working, `🔔 1` waiting for you, `✓ 3` all idle | Every open conversation with its state, how long it has been in it and the tool running now | Summary of the current task |
| **Usage** | `5h 33% · 7d 5%` | Limit bars with reset times, extra usage, plus tokens and API-equivalent cost from local transcripts (5-hour window, today, week, per model) | Refresh |

The usage item turns orange at 80% (configurable) and red at 95%.

The **task summary** is built from the local transcript, with no AI call and no cost:

- the prompt being worked on,
- the tool running right now,
- the to-do plan, when Claude made one,
- the last steps (files read or edited, commands run),
- Claude's last message,
- tokens and API-equivalent cost of the conversation.

It refreshes live while it stays open.

**Notifications** pop up when a conversation in the current window needs your answer or a permission. Optionally, they also pop up when a conversation finishes.

## Requirements

- The [Claude Code](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code) VS Code extension. Only conversations started from the extension are listed, not terminal ones.
- For subscription limits, a Claude Pro, Max, Team or Enterprise login in Claude Code. With an API key, only local token usage is shown.

## How it works and privacy

- **Conversations** come from the status files Claude Code writes in `~/.claude/sessions/`. Summaries come from the transcripts in `~/.claude/projects/`. Everything is read locally.
- **Tokens and cost** are computed from the same transcripts. The cost uses public API list prices. It is an indication of the value consumed, not what the subscription bills.
- **Subscription limits** come from the endpoint Claude Code's `/usage` uses. The call is authenticated with the login Claude Code already stored (`~/.claude/.credentials.json`, or the Keychain on macOS).
  - The token is sent only to `api.anthropic.com`.
  - The extension never refreshes or modifies the token.
  - The result is shared between VS Code windows, so the endpoint is called at most once every two minutes by default.
- Nothing else leaves your machine. There is no telemetry.

The files and the endpoint are Claude Code internals and are not documented, so a Claude Code update may break part of the extension. When a data source is missing, the matching section shows a message and the rest keeps working.

## Settings

| Setting | Default | |
|---|---|---|
| `claudeMonitor.sessions.scope` | `all` | `all` lists conversations from every VS Code window. `workspace` lists only the current window's. |
| `claudeMonitor.notifications.onWaiting` | `true` | Notify when a conversation waits for you |
| `claudeMonitor.notifications.onDone` | `false` | Notify when a conversation finishes its turn |
| `claudeMonitor.planUsage.enabled` | `true` | Fetch subscription limits |
| `claudeMonitor.planUsage.refreshSeconds` | `120` | Refresh interval for the limits (minimum 60) |
| `claudeMonitor.warningThreshold` | `80` | Percentage at which the status bar turns orange |
| `claudeMonitor.claudeConfigDir` | | Claude Code config directory, when it is not `~/.claude` or `$CLAUDE_CONFIG_DIR` |

## Development

```sh
npm install
npm run watch      # then F5 in VS Code ("Run Extension")
npm run typecheck
npm run package    # builds the .vsix
```

---

## En français

L'extension affiche, dans la barre d'état en bas à droite :

- **l'état des conversations Claude Code** : un spinner si Claude travaille, une cloche s'il attend une réponse. Le survol liste les conversations ; un clic ouvre le résumé de la tâche en cours.
- **les limites de l'abonnement** : la session de 5 h et la semaine. Le survol donne le détail des tokens et du coût équivalent API.

Toute la lecture est locale. Seul l'appel des limites contacte `api.anthropic.com`, avec la connexion déjà enregistrée par Claude Code. L'interface est en français si VS Code l'est.
