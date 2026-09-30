# The recorder server: a beginner's guide

## What is this, in plain words?
A **server** is just a computer that lives in a data centre and is always switched on. You rent it by the hour, like renting a hall. You never touch it physically. The recorder is a program that runs on it, joins each class quietly, and saves the video.

Why not use the school laptop? A laptop has to stay on, stay online, and stay free for the whole class. A rented server always has power and fast internet.

## The plan
1. **Test first (a few hours, well under $1).** Rent one server, run a load test, then *delete* it. This tells us how many classes one server can record at once, so we buy the right size.
2. **Then go live** with the right size, only after Jason agrees.

## What to rent
| | |
|---|---|
| Company | **Hetzner** (hetzner.com/cloud): cheap by the hour, servers in Germany, close to your Backblaze storage |
| Plan | **CCX23** (Dedicated vCPU, 4 cores, 16 GB memory) |
| Place | **Nuremberg** or **Falkenstein** (Germany) |
| System | **Ubuntu 24.04** |
| Cost | about **$0.14 per hour** (Hetzner raised prices in June 2026; check the price on the order page). A 3-hour test is well under $1. |

"Dedicated" matters: the cores are yours alone, so the test measures the real thing. Cheaper "shared" plans share cores with other customers and give unreliable numbers.

## Step by step
1. Go to **hetzner.com/cloud**, click **Sign up**, and create an account. They may ask for a card, and sometimes an ID photo, before allowing servers. Nigerian cards are sometimes declined; if that happens, see "If Hetzner will not take your card" below.
2. In the console, create a **Project** (call it `eduprime`).
3. Click **Add Server** and choose:
   - Location: **Nuremberg** (or Falkenstein)
   - Image: **Ubuntu 24.04**
   - Type: **Dedicated vCPU → CCX23**
   - Networking: keep **Public IPv4** ticked (needed)
   - SSH keys: leave empty (the next box handles it)
   - **Cloud config** (sometimes called "User data"): open `deploy\cloud-init.generated.yaml`, copy **everything**, and paste it in
   - Name: `eduprime-recorder-test`
4. Click **Create & Buy now**. After about a minute the server shows an **IPv4 address** (four numbers like `203.0.113.10`).
5. **Send that address to Claude.** Claude does the rest from your laptop.
6. When Claude says the test is finished, **delete the server** (see below).

## IMPORTANT: delete it afterwards
Hetzner charges while a server *exists*, even if switched off. When the test is done: open the server in the console → **⋯ menu → Delete**. Then check the project shows **no servers**.

## Safety
- The server is reached with a **key** stored on your laptop (`%USERPROFILE%\.ssh\eduprime-recorder-test`). Nobody without that file can log in.
- For the test, the LiveKit keys are copied onto the server and disappear when you delete it. After the test, it is good practice to make new LiveKit keys (LiveKit dashboard → Settings → API keys).
- Nothing on this server can reach your students' data or the school website.

## If Hetzner will not take your card
Any of these work the same way; pick **Ubuntu 24.04**, **4 dedicated/CPU-optimised cores**, and paste the same text into the box called "user data" or "cloud-init":
- DigitalOcean: *CPU-Optimized* droplet, 4 vCPU
- Vultr: *Dedicated CPU*, 4 vCPU
- Akamai/Linode: *Dedicated CPU*, 4 cores

## What Claude does once you send the address
1. Sends the recorder to the server and builds it (`deploy\deploy.ps1 -Server <address> -Bench`).
2. Runs the load test with 1, 2 and then 4 pretend classes at once, in real LiveKit rooms.
3. Shows you a table: how many cores each class really uses, whether any picture froze, and how many classes this size of server can safely handle.

## Later, for real classes
- `deploy\env.server.example` lists every setting.
- `deploy\Caddyfile` gives the server a secure `https://` address automatically once a domain name points to it.
- Because the school only needs recording for a few hours each morning, servers can be switched on just for those hours, which is much cheaper than leaving one running all month. That is a later step.
