#!/bin/sh
# Rooted TVs only. scripts/tv-preview.sh and scripts/tv-home.sh install copy this to
# /var/lib/webosbrew/init.d/50-ambient-home, which the Homebrew Channel runs as root at every boot, and run it once
# with --now (no Helper start).
# 1. LG's devmode.conf runs chmod -R 777 /media/developer at every boot. Home Helper refuses to start with a
#    world-writable data folder, so put back the modes scripts/fix-ipk.py gives the packages, and the jailer group
#    (5000) that lets Helper and Ambient Home's service share Helper's data folder.
# 2. Ambient Home's service runs in a jail that sees only its own folder; bind Helper's folder in, so Settings can
#    tell whether Helper is installed and running and switch the Home button.
# 3. While the Home button is set to Ambient Home, have LG's boot service open it when the TV is switched on
#    (sh 50-ambient-home --off takes that back).
# 4. Start tv-root-live.js, which keeps Ambient Home's list of apps and inputs up to date.
# 5. At boot, start Helper if Home is set to Ambient Home and Home was not pressed three times.
A=/media/developer/apps/usr/palm
HELPER=$A/applications/com.local.nativehome
STATE=$HELPER/state

for d in $A/applications/com.local.ambienthome $A/services/com.local.ambienthome.service \
         $HELPER $A/services/com.local.nativehome.service; do
  [ -d "$d" ] || continue
  find "$d" -name state -prune -o -type d -exec chmod 755 {} + -o -type f -exec chmod 644 {} +
  find "$d" -name state -prune -o -type f -print | while read -r f; do
    [ "$(head -c 4 "$f" | tail -c 3)" = ELF ] && chmod 755 "$f"
  done
done
# Ambient Home's service leaves requests for tv-root-live.js (Settings > Running apps) in its own state folder.
[ -d $A/services/com.local.ambienthome.service ] && mkdir -p $A/services/com.local.ambienthome.service/state
for s in $STATE $A/services/com.local.nativehome.service/state $A/services/com.local.ambienthome.service/state; do
  [ -d "$s" ] || continue
  chmod 770 "$s"
  chgrp -R 5000 "$s"
  find "$s" -type f -exec chmod 660 {} +
done
[ -f $STATE/ssap-key.json ] && chmod 640 $STATE/ssap-key.json
for f in $STATE/apps.json $STATE/controller.pid $STATE/controller.log $STATE/blocked \
         $A/services/com.local.nativehome.service/state/startup-state.json; do
  [ -f "$f" ] && chmod 644 "$f"
done

J=/var/palm/jail/com.local.ambienthome.service$HELPER
if [ -d "$HELPER" ] && ! grep -qs " $J " /proc/mounts; then
  mkdir -p "$J" && mount --bind "$HELPER" "$J"
fi

# Power-on straight into Ambient Home. LG's boot service (bootd) opens the first app by why the TV was switched on
# (common.firstAppByPowerOnReason in /etc/palm/bootd.json: the power button opens the last input), and reads
# /var/luna/preferences/bootd.json instead when it exists. While the Home button is set to Ambient Home, that copy of
# LG's file sends the power button, the TV's own button and a cold start to Ambient Home, which then opens behind
# LG's start-up cover; every other reason (a console over HDMI-CEC, a network wake-up, the Netflix button) stays
# LG's. bootd reads it as the TV starts, so a change counts from the next start. Only a copy written here (its md5
# is kept) is ever replaced or removed; --off removes it.
BOOTD=/var/luna/preferences/bootd.json
BOOTD_MARK=/var/lib/webosbrew/ambient-home/bootd.md5
bootd_ours() { [ -s $BOOTD ] && [ "$(md5sum $BOOTD | cut -d ' ' -f 1)" = "$(cat $BOOTD_MARK 2>/dev/null)" ]; }
if [ "$1" = --off ]; then
  bootd_ours && rm -f $BOOTD $BOOTD_MARK && sync
  exit 0
fi
[ -f $BOOTD ] && [ ! -s $BOOTD ] && bootd_ours && rm -f $BOOTD
if [ -d $A/applications/com.local.ambienthome ] && [ ! -e $STATE/blocked ] &&
   grep -qs '"enabled":true' $STATE/home-control.json; then
  if [ ! -e $BOOTD ] || bootd_ours; then
    node -e '
      const fs = require("fs"), c = JSON.parse(fs.readFileSync("/etc/palm/bootd.json", "utf8"));
      const table = c.common && c.common.firstAppByPowerOnReason;
      if (!table) process.exit(1);
      ["remoteKey", "localKey", "micomPower"].forEach((why) => { table[why] = "com.local.ambienthome"; });
      const text = JSON.stringify(c, null, 4) + "\n";
      JSON.parse(text);
      fs.writeFileSync(process.argv[1], text, { mode: 0o644 });
    ' $BOOTD.tmp && [ -s $BOOTD.tmp ] && mkdir -p ${BOOTD_MARK%/*} &&
      md5sum $BOOTD.tmp | cut -d ' ' -f 1 > $BOOTD_MARK && mv -f $BOOTD.tmp $BOOTD && sync
    rm -f $BOOTD.tmp
  fi
elif bootd_ours; then
  rm -f $BOOTD $BOOTD_MARK && sync
fi

# Keep Ambient Home's list of the TV's apps and inputs up to date (tv-root-live.js). After an install (--now) the
# running copy makes way for the new one.
LIVE=/var/lib/webosbrew/ambient-home/tv-root-live.js
if [ -f "$LIVE" ] && [ -d $A/applications/com.local.ambienthome ]; then
  pid=$(cat /tmp/ambient-home-live.pid 2>/dev/null)
  if [ "$1" = --now ] && [ -n "$pid" ] && kill "$pid" 2>/dev/null; then sleep 1; fi
  (cd / && setsid node "$LIVE" </dev/null >/dev/null 2>&1 &)
fi

[ "$1" = --now ] && exit 0

running() {
  pid=$(cat $STATE/controller.pid 2>/dev/null)
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  case "$(tr '\0' ' ' < /proc/$pid/cmdline 2>/dev/null)" in
    'com.local.nativehome '*|*/com.local.nativehome/native.js*) return 0 ;;
  esac
  return 1
}
# Helper's own start with the TV may have run before the repairs above; give it time, then start it if it did not.
(
  sleep 30
  [ -d "$HELPER" ] && [ ! -e $STATE/blocked ] && grep -qs '"enabled":true' $STATE/home-control.json || exit 0
  running || luna-send -n 1 -w 10000 luna://com.webos.applicationManager/launch \
    '{"id":"com.local.nativehome","params":{"nativeHomeStart":true}}' >/dev/null 2>&1
) </dev/null >/dev/null 2>&1 &
exit 0
