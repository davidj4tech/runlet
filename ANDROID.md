# Android: Developer options and ADB for Runlet

This guide connects a phone to an existing Runlet host computer. The assistant sends a command to Runlet on that host; the host uses ADB to reach the phone.

A Runlet Android app and Android installer are not implemented yet. The final section describes proposed app onboarding. Developer options are needed for ADB; ordinary Termux scripts do not require them.

## 1. Enable Developer options on the phone

1. Open **Settings** and find **Build number**.
2. Tap it seven times. Complete any device-unlock prompt.
3. Find **Developer options** in Settings.

| Phone | Where to find Build number |
| --- | --- |
| Google Pixel | Settings → About phone → Build number |
| Samsung Galaxy | Settings → About phone → Software information → Build number |
| Other manufacturers | Search Settings for “Build number”; names and locations vary |

Enabling Developer options does not root the phone. Leave OEM unlocking alone; this setup does not need it. [Android's Developer options guide](https://developer.android.com/studio/debug/dev-options)

## 2. Prepare the Runlet host

Install the latest [Android SDK Platform Tools](https://developer.android.com/tools/releases/platform-tools) on the computer running Runlet. Android Studio is optional.

Add the extracted platform-tools directory to the PATH available to the Runlet service, or use the absolute path to adb. A PATH set only in your interactive terminal may not reach a background service.

On that host, check:

```sh
adb version
```

All commands below run on this host, not in the phone's ordinary terminal. Windows PowerShell users running from the extracted directory can use `./adb.exe`; a Runlet runner in WSL needs access to its own ADB executable and connection. USB access inside WSL requires additional configuration; the native Windows ADB connection is not automatically shared.

## 3. Pair wirelessly (Android 11+ phones)

Connect the host and phone to the same Wi-Fi network. On the phone:

1. Open **Developer options → Wireless debugging** and enable it.
2. Choose **Pair device with pairing code**.
3. Keep that screen open.

On the host, substitute the address and pairing port shown there:

```sh
adb pair PHONE_IP:PAIRING_PORT
```

Enter the displayed pairing code when prompted. Check for an automatic connection:

```sh
adb devices -l
```

If none appears, return to the main Wireless debugging screen and use its **IP address & port**:

```sh
adb connect PHONE_IP:CONNECTION_PORT
adb devices -l
```

**The pairing port and connection port are different.** Use the values currently displayed on the phone, not fixed example ports. Discovery and reconnection behavior vary with Android and Platform Tools versions. [Android's ADB guide](https://developer.android.com/tools/adb#connect-to-a-device-over-wi-fi)

## 4. USB alternative

Enable **USB debugging** in Developer options. Connect a data-capable USB cable, unlock the phone, and approve its debugging authorization prompt for your host.

```sh
adb devices -l
```

The device should have state `device`. Windows may need a manufacturer USB driver; Linux may need USB access rules. If it is missing, try another cable or USB port. If it is `unauthorized`, check the unlocked phone for the authorization prompt. [Android's hardware-device setup](https://developer.android.com/studio/run/device)

## 5. Test through Runlet

Copy the exact device identifier from `adb devices -l`. It may be a USB serial, network endpoint, or discovery name. Replace `DEVICE_ID` in these examples:

```sh
adb -s DEVICE_ID shell getprop ro.product.model
adb -s DEVICE_ID shell id
```

The first reads the model; the second shows the shell identity. These checks do not change phone settings.

Ask your assistant:

> Through Runlet, list the ADB devices. Use device DEVICE_ID to read its model and shell identity.

Always select the device explicitly when several phones are connected. This is especially useful for a host managing a phone fleet.

Runlet supplies the host shell; ADB supplies the authorized phone connection. A phone outside the host's USB/Wi-Fi reach will need a separate connectivity design. The Runlet connector alone does not make a phone's private Wi-Fi address reachable.

ADB is not root access on a normal production phone, and does not generally expose other apps' private data. An ordinary Android app also remains subject to Android's [application sandbox](https://source.android.com/docs/security/app-sandbox).

## Reconnect or disconnect

If a wireless endpoint stops working, check the phone's current connection address and retry `adb connect`. Pair again if its host authorization has been removed.

To close a specific wireless connection:

```sh
adb disconnect PHONE_IP:CONNECTION_PORT
```

To revoke trust, open **Wireless debugging → Paired devices**, select the host, and choose **Forget**. Turn off the relevant debugging toggle when no longer wanted. Disconnecting alone does not revoke pairing. [ADB pairing and removal](https://developer.android.com/tools/adb#connect-to-a-device-over-wi-fi)

## Proposed Android app onboarding

This is a design outline, not an available feature.

Offer an optional **Enable phone control with ADB** flow:

1. **Explain access:** distinguish ordinary app/Termux commands from commands through ADB.
2. **Open Settings:** show the Build number instructions, then guide the user to Developer options and Wireless debugging.
3. **Pair:** identify which component is pairing—the computer, Termux, or a future embedded ADB client—and request the matching endpoint/code. Runlet pairing and Android ADB pairing must be labelled separately.
4. **Test connection:** display the detected phone model, connection state, and shell identity; require an explicit device choice if several are available.
5. **Reconnect and revoke:** explain recovery after a lost connection and provide clear disconnect/forget instructions.

A phone-only experience would need an ADB client in the app or an explicit Termux integration, plus on-device pairing tests. Enabling Developer options alone does not grant an app ADB access. The user must perform Android's settings and authorization steps.
