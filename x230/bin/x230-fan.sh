#!/bin/bash
# X230 fan curve: quiet when cool, aggressive above 72C. Failsafe -> level 4.
FAN=/proc/acpi/ibm/fan
last=0
set_level() {
  echo "level $1" > "$FAN" 2>/dev/null
}
while true; do
  t=$(sensors -u coretemp-isa-0000 2>/dev/null | awk '/temp1_input/{printf "%d", $2; exit}')
  [ -z "$t" ] && t=70
  # hysteresis: 4C between up/down thresholds
  case "$last" in
    [1-7]) up=$(( last == 1 ? 54 : last == 2 ? 62 : last == 3 ? 68 : last == 4 ? 74 : last == 5 ? 78 : 80 )) ;;
    *) up=54 ;;
  esac
  if   [ "$t" -ge 80 ]; then lvl=7
  elif [ "$t" -ge 74 ]; then lvl=6
  elif [ "$t" -ge 68 ]; then lvl=5
  elif [ "$t" -ge 62 ]; then lvl=4
  elif [ "$t" -ge 54 ]; then lvl=2
  else lvl=1
  fi
  if [ "$lvl" != "$last" ]; then
    set_level "$lvl"; last=$lvl
  fi
  sleep 5
done
