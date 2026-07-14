# Optional Namecheap VPS fallback

This topology is not required for the initial commercial launch. It is retained only as a future scale-up path if the included shared-hosting account reaches its resource limits.

The fallback uses one Namecheap VPS running Ubuntu, Nginx, Node.js 22, and a current supported PostgreSQL release. It must not be ordered without a separately reviewed total and the owner's explicit purchase approval.

## Services

- Nginx terminates TLS and serves the public, API, and release hostnames.
- Node.js runs the Fastify API under systemd on localhost.
- PostgreSQL listens only on localhost or its Unix socket.
- Off-server encrypted backups retain 30 daily and 12 monthly copies and receive a monthly restore test.

The desktop app continues to keep brokerage credentials and trading decisions on the customer's own computer. The server stores only commerce, activation, release, and privacy-safe operational records.
