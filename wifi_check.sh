#!/bin/bash

# Check if connected to a Wi-Fi network
if ! sudo nmcli -t -f active,ssid dev wifi | egrep '^yes' | cut -d: -f2; then
    echo "Not connected to Wi-Fi. Starting hotspot..."
    # Stop any existing hotspot
    sudo nmcli con down Hotspot
    # Create a new hotspot
    sudo nmcli dev wifi hotspot ifname wlan0 ssid PrinterHotspot password "printer123"
else
    echo "Connected to Wi-Fi."
fi