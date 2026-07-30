# Crop Care Advisor

Plan the care of everything you grow. Add multiple crops and get one combined care schedule instead of looking up each plant separately, plus a warning when two of your crops need conditions that cannot both be met in the same place.

**Live site:** https://www.tounda.tech
**Demo video:** ADD_LINK_HERE

## Why this exists

Looking up a single plant's care requirements is easy. Keeping track of several at once, and knowing whether they can even share a garden bed, is the actual hard part. This app is built around that specific problem rather than being a search box wrapped around an API.

## Features

- Search any plant or crop by name (try tomato, bean, or corn)
- Filter by sunlight needs, water needs, life cycle, and edible-only
- Sort results (name A-Z, Z-A, or by water needs)
- Build a personal garden of everything you're growing
- Automatic conflict detection between crops with incompatible growing needs
- Auto-generated monthly care plan built from everything in your garden
- Server-side caching so the API's daily request limit isn't wasted on repeat lookups

## API used

Perenual Plant API (https://perenual.com/docs/api). Plant species data, growing conditions, and care details. All plant data credit belongs to the Perenual API developers. Free tier.

## Tech stack

- Node.js and Express (backend; keeps the API key server-side, never sent to the browser)
- Vanilla HTML, CSS, and JavaScript (frontend, no framework)
- PM2 (keeps the app running and restarts it on server reboot)
- Nginx (reverse proxy from port 80 to the app's port 3000, adds the X-Served-By header)
- HAProxy (load balancing and SSL termination across Web01/Web02)

## Running locally

1. git clone https://github.com/DTounda/crop-care-advisor.git
2. cd crop-care-advisor
3. npm install
4. Copy .env.example to .env and add a free Perenual API key from https://perenual.com/user/developer
5. node server.js
6. Open http://localhost:3000

No login or account is required to use this application.

## Deployment (Web01 and Web02)

Identical steps on each server:

    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs git
    sudo npm install -g pm2
    git clone https://github.com/DTounda/crop-care-advisor.git
    cd crop-care-advisor
    npm install

Create .env, identifying which server this is:

    PERENUAL_API_KEY=your_key
    PORT=3000
    SERVER_NAME=web-01

(web-02 on the second server.)

Start it under PM2 and enable restart-on-reboot:

    pm2 start server.js --name crop-advisor
    pm2 save
    pm2 startup

Then run the sudo env PATH=... command that pm2 startup prints.

Nginx reverse-proxies port 80 to the app and stamps every response with the server's hostname. Config used on both servers:

    server {
        listen 80 default_server;
        server_name _;
        add_header X-Served-By $hostname always;
        location / {
            proxy_pass http://127.0.0.1:3000;
            proxy_http_version 1.1;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
        }
    }

## Load balancer (Lb01)

HAProxy sits in front of Web01 and Web02 and distributes traffic round-robin. SSL termination was already configured for this domain in an earlier project, so HTTPS traffic is decrypted at the load balancer and forwarded to whichever backend is next in rotation.

Confirm round-robin is genuinely working:

    curl -sIk https://www.tounda.tech | grep -i x-served-by

Run it several times in a row using fresh connections (a browser tab reusing one open connection will not show this). It should alternate between 7134-web-01 and 7134-web-02.

## Challenges encountered

- Header casing through HAProxy: nginx returns X-Served-By in mixed case, but HAProxy lowercases it when proxying HTTPS traffic. A case-sensitive check made the load balancer look broken when it was actually working the whole time, fixed with a case-insensitive check instead.
- Windows line endings and lost executable permissions: editing deployment scripts from PowerShell repeatedly reintroduced Windows-style line endings and reset git's executable bit, breaking scripts on the Linux servers. Fixed by doing all script creation and git operations from one WSL2 terminal instead of switching environments.
- Different SSH keys per server: Web01, Web02, and Lb01 each required a different private key depending on when they were provisioned. Resolved by comparing key fingerprints against what each server actually accepted.

## API key

Provided separately in the assignment submission comment, per the assignment's instructions.

## Credits

- Plant data: Perenual API (https://perenual.com)
- Built by Dorcase Lesly Nana Tounda
