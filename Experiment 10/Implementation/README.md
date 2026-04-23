# ⚡ FlashTix — Flash Ticket Booking System

This is a mini-project that shows how sites like Ticketmaster handle massive ticket sales without crashing or accidentally selling the same seat to two different people. 

### 🤔 How it Works (The Basics)

Instead of letting everyone buy tickets at the exact same time, the system manages the chaos using a few simple rules (powered by Redis behind the scenes):

* **The Waiting Room:** When you want to buy a ticket, you join a virtual queue. You wait in line until you are in the top 6.
* **Seat Locking:** Once it's your turn, you click a seat to lock it. That seat is instantly reserved for you for 2 minutes. No one else can click it while you're checking out.
* **Auto-Release:** If you close your browser or take too long, the 2-minute timer runs out, and the seat is automatically freed up for the next person in line.
* **Spam Protection:** If someone tries to run a bot or refresh the page too fast, the system catches it and temporarily blocks them.

---

### 🚀 How to Run It

You just need [Docker](https://www.docker.com/get-started) installed on your computer. 

1. Open your terminal and navigate to the project folder.
2. Run this command to build and start the database and server:
   ```bash
   docker compose up --build
   ```
3. Open your web browser and go to: **http://localhost:3000**

*Note: To stop the app, just hit `Ctrl+C` in your terminal or run `docker compose down`.*