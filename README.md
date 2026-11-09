# openbee Linear channel

Linear channel for openbee, built on [`@theopenbee/channel-sdk`](https://www.npmjs.com/package/@theopenbee/channel-sdk). It replaces the Linear channel that used to be built into openbee and keeps its config, session keys and stored conversations.

## Behaviour

- Polls Linear with a personal API key, so openbee needs no public address or webhook.
- Handles issues that carry the gating label (`openbee` by default), belong to one of the listed projects and are in one of the listed workflow states. Everything else is ignored.
- A new issue becomes one message: project, title, description and the comments it already has. Later comments become messages of their own. Each issue is one openbee session (`linear:<team key>:<issue identifier>`, for example `linear:ENG:ENG-42`), the same keys the built-in channel used.
- Every message that reaches openbee gets an 👀 reaction.
- Replies are posted as comments. A reply to a comment goes into that comment's thread; a reply to an issue, and every scheduled or proactive message, goes to the top level of the issue. openbee's comments start with `[openbee-bot]` and are never read back as messages.
- Images and files attached to issues and comments (`uploads.linear.app`) up to `max_media_size` bytes are downloaded into openbee's media directory. In the text they show up as `[image: name]` or `[file: name]`; attachments that cannot be downloaded stay as links.
- Files sent by workers are uploaded to Linear and embedded in the comment, pictures as images and anything else as a link.
- Which issues and comments were already handled is kept in the plugin data directory. On its first start the plugin copies this state from `~/.openbee/.linear/`, where the built-in channel kept it, so existing issues are not handled again.

## Install

Install it from **Settings → Plugins → Marketplace**, or run:

```sh
openbee plugin install @theopenbee/channel-linear
```

Or from a local checkout:

```sh
git clone https://github.com/theopenbee/channel-linear.git
cd channel-linear
npm install
openbee plugin install "$(pwd)"
```

Then fill in its settings and enable it under **Settings → Plugins** in the desktop app or the web console, or run `openbee plugin configure linear`. Setup guide: https://theopenbee.com/docs/chat-apps/linear/

Settings, also accepted as `openbee plugin configure linear --set key=value`:

| Key | Default | |
|---|---|---|
| `api_key` | | Personal API key from https://linear.app/settings/api. Required. Replies are posted as this user. |
| `label_name` | `openbee` | Only issues with this label are handled. |
| `projects` | | Project names to watch. Required. |
| `states` | | Workflow state names to watch, for example `Todo`. Required. |
| `poll_interval` | `10s` | How often to poll, as a duration such as `30s` or `1m`. |
| `max_media_size` | `52428800` | Largest attachment, in bytes, downloaded or sent. |

## Development

```sh
npm install
npm test
```

`npm install` also builds `dist/`; run `npm run build` after changing `src/`. The tests run offline against a local fake of the Linear API.
