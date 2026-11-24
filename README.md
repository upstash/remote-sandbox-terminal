# remote-sandbox-terminal

opencode runs in an Upstash Box. Your terminal, on any machine, is its screen and
keyboard. Everything in between travels over Upstash Realtime.

```
your terminal ── oc ──▶ Upstash Realtime (Redis) ◀── host ── opencode in a PTY, in the box
```

The host starts opencode in a pseudo-terminal and publishes every byte it writes.
The client puts your terminal in raw mode, writes those bytes to it, and publishes
every byte your terminal produces: keys, mouse, paste, and the answers to the
questions opencode asks a terminal at startup. opencode cannot tell the difference.

## Use

```sh
git clone https://github.com/upstash/remote-sandbox-terminal
cd remote-sandbox-terminal
cp .env.example .env  # fill in the values listed under Config
bun install
bun run build
bun box up            # creates the box, installs the host, starts it
node dist/oc.mjs      # opencode, from the box
```

`npm link` once makes that `oc`.

- **Ctrl+]** detaches. opencode keeps running in the box, including an agent that
  is mid-task. Run `oc` again, from any machine, to come back to the same screen.
- Quitting opencode (`/exit`) ends it. The next `oc` starts a new one.
- A box that sits unused is paused. `oc` wakes it and opencode reopens the
  conversation it was in.

### Another machine

It needs Node 20.18 or newer and one file.

```sh
node dist/oc.mjs link          # here: prints a link
node oc.mjs link <link>        # there, with dist/oc.mjs copied over
node oc.mjs
```

The link holds the Redis token and the Box API key. Anyone who has it can type
into your box.

## Config

`.env` in this directory:

| Variable | |
| --- | --- |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | The database Realtime runs on. Put it in us-east-1, next to the box. |
| `UPSTASH_BOX_API_KEY` | Creates the box, and lets a client wake it. |
| `OC_SESSION` | Channel name. Default `main`. |

After changing the database, run `bun box up` again.

Host options, set in the box's `.opencode-remote/.env`: `OC_FRAME_MS` (shortest
time between two output messages, default 33), `OC_CWD`, `OC_ARGS` (JSON array).

Both ends talk to Redis over a single HTTP/2 connection, which the subscription
keeps open. That is what keeps the first key after a pause as fast as the rest;
over HTTP/1.1 it had to wait for a new TLS handshake. `OC_HTTP1=1` switches back.

## Box

```sh
bun box status     # box state, host process, last log lines
bun box logs
bun box restart    # restarts the host
bun box down       # deletes the box
```

The host lives in `/workspace/home/.opencode-remote`, opencode works in
`/workspace/home`. Run `/connect` inside opencode to add your provider; the
login is stored on the box's volume.

## Running the host elsewhere

The host is not tied to a box. On any machine with opencode installed:

```sh
OC_CWD=~/code/project node dist/host.mjs
```

## Tests

```sh
bun run test:e2e       # host and client on this machine, through the real database
bun run test:box       # this machine's client against the host in the box
bun run test:recover   # a client with no host, and a host replaced under a client
node test/idle.mjs     # key-to-echo time after pauses of different lengths
node test/burst.mjs    # how far the screen lags a word typed after a pause
```

`idle`, `burst` and `test:box` type into whatever session `OC_SESSION` names. Point
them at a session nobody is using, not the one you are working in.

The client runs in a local pseudo-terminal wired to a headless terminal emulator,
so the tests read back the screen it actually drew.

## License

MIT
