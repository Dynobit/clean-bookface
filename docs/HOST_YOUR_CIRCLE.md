# Host your own circle

Your memories belong with you. You can keep a private archive here, then choose what to share and with whom. Importing never publishes your Facebook history.

**Just joining a friend?** You do not need a server or any of these commands. Ask them for an invitation and follow the [member guide](GETTING_STARTED.md).

## 1. Pick a home and an address

For a small circle, start with a Linux server with **4 GB RAM and at least 20 GiB free disk**. Archives need extra space: a few large photo collections can fill a small disk quickly. You will also need a domain you control and a separate place for backups. [Compare hosting costs](HOSTING.md).

Use an address you want to keep, such as `friends.your-domain.org`. Moving your circle to another server is possible; changing its address changes its identity.

Hosting means looking after updates, backups and a monthly bill. If that sounds like too much, joining someone you trust is the simpler choice. The host administrator can access stored data.

## 2. Prepare the server once

Use your server provider's instructions to install **Docker Engine with Docker Compose**, **Node.js 24**, and **Git**. Node runs the setup guide; the application itself runs in Docker. Use the provider's server terminal for the commands below.

In your domain provider's dashboard, point your chosen address at the server's public IP. Allow incoming web traffic on ports **80 and 443**. If you have an IPv6 DNS record, it must point to this server too. These are provider settings; the setup guide does not change them for you.

This recipe assumes a dedicated server, with Docker running on that same server and no other website already using those ports. A home connection or a shared server needs extra planning; see [advanced installation](INSTALL.md).

## 3. Run the short setup guide

Until the repository is public, cloning requires authorized GitHub access. Use a reviewed release or commit when one is available.

```sh
git clone https://github.com/Dynobit/clean-bookface.git
cd clean-bookface
./setup
```

The guide checks Docker, available memory, and free space on both the checkout and Docker data filesystems, asks for your address and circle name, then asks you to type **START**. It builds the application and starts the web server. Your settings stay in a private `.env` file. It also keeps the Docker project name stable, so the maintenance commands still reach the same circle if you rename the project folder. It refuses to replace an existing installation or its data.

If your account cannot inspect Docker’s data directory, the guide stops before installation. Ask your server administrator to check that filesystem and use the manual installation reference; free space beside the checkout does not prove room for your memories.

The first build can take several minutes. Leave the terminal open. Connecting to other hosts starts switched off; people in your own circle can still use the application.

## 4. Make your account

Open your chosen HTTPS address. In your private server terminal, run:

```sh
./setup code
```

Paste that one-time code into the setup page. Create your account and save its recovery codes somewhere safe. Keep the terminal and codes out of screenshots, support messages and shared logs. After the first account exists, sign in normally.

## 5. Bring a small memory first

Start with fictional or disposable data. Follow the [Facebook download and import guide](GETTING_STARTED.md), check a private photo, and try an account export. You decide what to publish later.

Before inviting friends, open **Host tools → Set up backups** and complete the backup and restore walkthrough. The app explains the steps; it does not automatically schedule backups or provide permanent hosting. Once you have proved you can restore your circle, invite a friend and try sharing and removing a fictional post together.

You can download your Facebook information without deleting your Facebook account. Deletion is a separate choice: check your downloaded memories first. The member guide explains both paths.

## Something did not work?

- **Another setup owns the lock:** Only one guided setup can run on a server at a time, even from different copies of this repository. Let it finish. If it crashed, have the server administrator verify that the setup process and its Docker build/start commands have all stopped before removing the empty `/tmp/clean-bookface-setup.lock` directory. The guide never removes another setup’s lock automatically. Do not run manual installation commands alongside the guide.
- **The setup guide stopped:** Read its last message. It keeps existing settings and data. Run `./setup status` to inspect this circle's containers.
- **The address does not open:** Recheck the domain's DNS records and the server's incoming ports. HTTPS needs working DNS first and can take a few minutes. A running container does not prove the public address works.
- **The build or startup failed after settings were saved:** Correct the reported cause, then run `docker compose up -d --build --wait`. The guide intentionally refuses to overwrite `.env` on a second run.
- **The setup code is unavailable:** Check `./setup status`. If you already created the first account, use the sign-in page instead.
- **You need help:** Share the error description and software version, never your `.env`, codes, archives or private logs. Inspect any diagnostic text before sharing it.

For updates, backups, moving servers, optional connections to other hosts and managed platforms, keep the [installation reference](INSTALL.md) and [operations guide](OPERATIONS.md) nearby. Do not remove Docker volumes during routine maintenance: that removes the memories stored in them.
