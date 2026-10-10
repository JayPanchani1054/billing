# Installing Pevqori

Pevqori is a Windows desktop program. It needs no server, no account and no internet connection: your
books stay in a folder on your computer. This page covers downloading, installing, choosing the data
folder, upgrading and uninstalling. Using the program is described in the [User Guide](USER_GUIDE.md).

## System requirements

- **Windows 10 or Windows 11, 64-bit** (x64). There is no 32-bit, ARM, macOS or Linux installer.
- No administrator rights for the usual "Only for me" installation.
- Disk space for the program, plus room for your data and its backups (each company is one database
  file; backups are compressed copies of it).
- No internet connection is needed to run Pevqori. You need one only to download the installer — and to
  use the GST / TDS portals, e-mail or WhatsApp outside Pevqori.
- Optional: an A4 / A5 printer, an 80 mm or 58 mm thermal receipt printer (POS), a cheque printer, a
  barcode scanner that types like a keyboard.

## 1. Download the installer

You need one file, `Pevqori-Setup-<version>.exe`.

**From a Release (recommended).** On the project's GitHub page open **Releases**, choose the latest
release and download `Pevqori-Setup-<version>.exe` and `SHA256SUMS.txt`. Versions with a `-` in them
(such as `1.1.0-beta.1`) are pre-releases.

**From a CI build (the newest development version).** On the project's GitHub page open **Actions ›
CI**, choose a run with a green tick on the branch you want, and download the
**Pevqori-Windows-Installer** artifact at the bottom of the run's page (you must be signed in to GitHub
to download artifacts; they are kept for 30 days). It is a `.zip` holding the installer and
`SHA256SUMS.txt` — extract it first.

**Check the download (optional but recommended).** In PowerShell, in the folder you downloaded to:

```powershell
Get-FileHash .\Pevqori-Setup-<version>.exe -Algorithm SHA256
```

The hash must equal the line for that file in `SHA256SUMS.txt`.

## 2. Install

1. Double-click `Pevqori-Setup-<version>.exe`.
2. Windows may show a SmartScreen warning — see [Windows SmartScreen](#windows-smartscreen) below.
3. Choose **Only for me** (the default; installs under your own user profile, normally
   `%LOCALAPPDATA%\Programs\Pevqori`, no administrator rights needed) or **Anyone who uses this
   computer** (installs under Program Files and asks for administrator rights).
4. Keep or change the installation folder and finish. Shortcuts named **Pevqori** are created on the
   desktop and in the Start menu, and Pevqori starts.

### Windows SmartScreen

The installer is **not yet code-signed**, so Windows SmartScreen may say *"Windows protected your PC"*.
Click **More info**, check that the file name is `Pevqori-Setup-<version>.exe`, then click **Run
anyway**. Download only from the project's own Releases or Actions pages, and compare the SHA-256 hash
as above. Some company-managed computers block unsigned programs altogether; ask your IT department.
(How the project can sign its installers is described in [BUILD.md](BUILD.md#7-code-signing).)

## 3. First launch: choose the data folder

The first time Pevqori starts it asks **where to keep your data** and suggests `Documents\Pevqori`.

- Choose a folder **you control** on a local drive. A BitLocker-encrypted drive is ideal: a password
  inside Pevqori does not stop someone who can copy the files.
- Avoid folders that several computers write to at the same time. A company can be open on only one
  computer (and in one window) at a time; a lock file in its folder enforces this.
- If you already have Pevqori data (copied from another computer or an old drive), choose that folder —
  its companies appear in the list.

Then create your first company (**Alt+C**) or restore one from a backup (**Alt+R**) — see the
[User Guide](USER_GUIDE.md#1-getting-started).

## Choosing or changing the data folder

You can change the data folder later, whenever no company is open:

1. Close the company (**F3**) to reach **Select a Company**.
2. Click **Change…** next to the folder name at the top.
3. Pick the new folder and say what should happen to your companies:
   - **Move my companies there** — they move, with the `backups` and `trash` folders; the old folder is
     left empty.
   - **Copy my companies there** — the new folder gets a copy and you work on the copy; the old folder
     keeps its companies.
   - **Use the companies already in that folder** — nothing is moved (for a folder that already holds
     Pevqori data).

Every copied company is opened and integrity-checked before anything is removed from the old location.

## Where things are kept

```
<data folder>\                     chosen by you (default Documents\Pevqori)
  companies\<company-id>\          named after the company plus a short code, e.g. sharma-traders-k3x9q2
    company.db                     the company's books (one SQLite database)
    attachments\                   files attached to vouchers, ledgers and items
    exports\shared\                PDFs saved when sharing by e-mail / WhatsApp
  backups\<company-id>\            default backup folder, and the safety copies made before an upgrade
  trash\                           companies you deleted or replaced by a restore (never erased by Pevqori)

%APPDATA%\Pevqori\                program settings (window, theme, data folder, confirmed backup folders)
                                   and the edit log's check-points (see SECURITY.md §4.1)
%APPDATA%\Pevqori\logs\           log files (no passwords or voucher data)
```

- **Backups.** *Data › Backup* writes one `.pvqbak` file per backup, optionally encrypted with a
  password. Automatic backups run when the last one is more than a day old (on opening and on closing
  the company). The default folder is `backups\<company-id>` inside the data folder — choose a folder on
  another disk, a USB drive or a cloud-synchronised folder in **F12 › Backup**; Pevqori itself never
  uploads anything. See the [User Guide](USER_GUIDE.md#131-backups).
- **A company is just a folder.** With Pevqori closed you can copy `companies\<company-id>` into another
  computer's data folder and it appears in that computer's list. A backup folder chosen on the old
  computer must be confirmed again on the new one.

## 4. Upgrading

1. Make a backup of each company (*Data › Backup*) — a habit worth keeping before any upgrade.
2. Close Pevqori and run the new `Pevqori-Setup-<version>.exe`. It replaces the program; your data folder
   and settings are not touched.
3. Open each company. If the new version needs to update a company's database, it first saves a safety
   copy as `backups\<company-id>\pre-upgrade-v<N>-<date-time>.db` in the data folder and then updates it.

Once a company has been opened with a newer version, older versions refuse to open it ("This company was
created by a newer version of Pevqori") rather than damage it — so upgrade every computer that uses the
same company. A backup folder chosen with an older version is confirmed once after upgrading. There is
no automatic update: install new versions yourself.

**Upgrading from a build made before the product was renamed.** On its first launch the new version
copies your settings (the chosen data folder, confirmed backup folders, the edit log's check-points,
window position and zoom) from the earlier build's settings folder, once and only when it has none of its
own yet; the old folder is left in place and your companies stay where they are. Backups made by earlier
builds — files with the earlier backup extension — are still listed, verified and restored like `.pvqbak`
files; new backups are always written as `.pvqbak`.

## 5. Uninstalling

Use **Settings › Apps › Installed apps › Pevqori › Uninstall** (or *Add or remove programs*). This
removes the program only. **Your data folder, its backups and the settings in `%APPDATA%\Pevqori` are
kept**; delete them yourself only when you are sure you no longer need them (make a backup first).
Reinstalling later finds the same data.

## 6. Moving to a new computer

Either make a backup on the old computer and restore it on the new one (**Alt+R** on *Select a
Company*), or close Pevqori on the old computer, copy the whole data folder across and choose it at first
launch (*Use the companies already in that folder*). Install the same or a newer version of Pevqori on the
new computer. The edit log's check-points stay on the old computer (they belong to your Windows account
there): on the new one, *Verify edit log* checks the hash chain and starts recording new check-points —
see [SECURITY.md](SECURITY.md#41-edit-log-integrity-what-is-detected-and-the-limits).

## Building from source

Developers build the installer themselves with Node.js and npm on Windows — see [BUILD.md](BUILD.md).
