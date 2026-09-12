# Firebase Setup Guide for TradeCommand

To connect your MT5 Bridge EA and Mobile App, follow these steps to set up a free Firebase project.

## Step 1: Create Project
1.  Go to the [Firebase Console](https://console.firebase.google.com/).
2.  Click **"Add project"**.
3.  Name it `TradeCommand` (or similar).
4.  Disable "Google Analytics" (not needed for this).
5.  Click **"Create project"**.

## Step 2: Enable Realtime Database
1.  In the left sidebar, expand **Build** and click **Realtime Database**.
2.  Click **"Create Database"**.
3.  Select a location (e.g., `United States` or `Belgium`).
4.  **Important:** Choose **"Start in Test Mode"** (allows read/write access for 30 days - we will secure this later).
5.  Click **"Enable"**.

## Step 3: Get API Key
1.  Click the **Gear Icon** (Project Settings) next to "Project Overview" in the top-left sidebar.
2.  In the **General** tab, scroll down to the "Your apps" section.
3.  Click the **Web icon** (`</>`).
4.  Register the app (nickname: `BridgeEA`).
5.  You will see a config object. Copy the **`apiKey`** string (e.g., `AIzaSyD...`).
6.  Also note your **`projectId`** (e.g., `tradecommand-12345`).

## Step 4: Configure EA
You will need these two values for the Bridge EA inputs:
*   **Inp_ProjectID**: `tradecommand-12345`
*   **Inp_ApiKey**: `AIzaSyD...`
