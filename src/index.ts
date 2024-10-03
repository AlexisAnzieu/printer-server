import express from "express";
import net from "net";
import EscPosEncoder from "esc-pos-encoder";
import sharp from "sharp";
import { Image, createCanvas } from "canvas";
import * as usb from "usb";
import { exec } from "child_process";
import util from "util";
import path from "path";
import fs from "fs";

const execCommand = util.promisify(exec);

const app = express();
app.use(express.urlencoded({ extended: true }));

const port = 9100;
const QR_CODE_URL = "https://flyprint.vercel.app/nath";

function initializePrinter() {
  try {
    // for rpi we need to make sure that usb is allowed
    // cd /etc/udev/rules.d
    // sudo vi 99-com.rules
    // add at the top SUBSYSTEM=="usb", ATTR{idVendor}=="0fe6", MODE="0666"
    // sudo udevadm control --reload-rules
    // sudo udevadm trigger
    console.log("Init printer");
    const printer = getPrinter();

    printer.open();
    console.log("printer opened");

    const iface = printer.interfaces?.[0];
    if (!iface || !claimInterface(iface)) {
      printer.close();
      throw new Error("Failed to claim interface");
    }

    const endpoint = iface.endpoints.find(
      (ep) => ep.direction === "out"
    ) as usb.OutEndpoint;
    if (!endpoint || typeof endpoint.transfer !== "function") {
      console.error("Invalid endpoint or transfer method");
      iface.release(() => printer.close());
      throw new Error("Invalid endpoint or transfer method");
    }

    return {
      printer,
      iface,
      endpoint,
    };
  } catch (err) {
    console.error("Failed to open printer:", err);
    return null;
  }
}

async function encodePrintData({
  pictureUrl,
  texts,
}: {
  pictureUrl?: string;
  texts?: string[];
}) {
  const PICTURE_WIDTH = 528;
  const PICTURE_HEIGHT = 712;
  const LOGO_WIDTH = 200;
  const LOGO_HEIGHT = 200;

  // @ts-ignore
  let encoder = new EscPosEncoder({
    createCanvas,
  });
  try {
    const logo = await getImage({
      pictureUrl:
        "https://res.cloudinary.com/dkbuiehgq/image/upload/v1727532228/resto_iu7mda.jpg",
      width: LOGO_WIDTH,
      height: LOGO_HEIGHT,
    });
    const date = new Date();
    const dateString = date.toLocaleString("en-GB", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

    encoder = encoder
      .initialize()
      .align("center")
      .image(logo, LOGO_WIDTH, LOGO_HEIGHT, "atkinson")
      .newline();

    if (pictureUrl) {
      const image = await getImage({
        pictureUrl,
        width: PICTURE_WIDTH,
        height: PICTURE_HEIGHT,
        rotate: 90,
      });
      encoder = encoder.image(image, PICTURE_WIDTH, PICTURE_HEIGHT, "atkinson");
    } else if (texts) {
      texts.map((text) => encoder.line(text));
    } else {
      encoder = encoder.qrcode(QR_CODE_URL, 2, 8, "h");
    }

    return encoder
      .newline()
      .line(dateString)
      .line("Auberge la Montagne Coupee - Quebec")
      .newline()
      .newline()
      .newline()
      .newline()
      .cut()
      .encode();
  } catch (err) {
    console.error("Failed to encode print data:", err);
    return null;
  }
}

function claimInterface(iface: usb.Interface) {
  try {
    iface.claim();
    console.log("Interface claimed");
    return true;
  } catch (err) {
    console.warn("Failed to claim interface on first attempt:", err);
    try {
      iface.detachKernelDriver();
      iface.claim();
      console.log("Interface claimed after detaching kernel driver");
      return true;
    } catch (err) {
      console.error(
        "Failed to claim interface after detaching kernel driver:",
        err
      );
      return false;
    }
  }
}

async function transferToEndpoint({
  posPrinter,
  result,
}: {
  posPrinter: {
    endpoint: usb.OutEndpoint;
    iface: usb.Interface;
    printer: usb.usb.Device;
  };
  result: Uint8Array;
}) {
  console.log("Printing...");

  return new Promise((resolve, reject) => {
    posPrinter.endpoint.transfer(result as Buffer, (error: any) => {
      if (error) {
        console.error("Print failed", error);
        reject("Print failed");
      } else {
        resolve("Print successful");
      }

      posPrinter.iface.release(() => posPrinter.printer.close());
    });
  });
}

async function printWithUSB({
  pictureUrl,
  texts,
}: {
  pictureUrl?: string;
  texts?: string[];
}) {
  const posPrinter = initializePrinter();
  if (!posPrinter) {
    throw new Error("Failed to initialize printer");
  }

  let result = await encodePrintData({ pictureUrl, texts });
  if (!result) {
    posPrinter.printer.close();
    throw new Error("Failed to encode print data");
  }

  return await transferToEndpoint({ posPrinter, result });
}

async function updateWifiConfig(ssid: any, psk: any) {
  try {
    await execCommand("sudo nmcli device wifi rescan");

    await execCommand(
      `sudo nmcli dev wifi connect "${ssid}" password "${psk}"`
    );
    await execCommand("sudo nmcli connection reload");
    return "WiFi settings updated. Please wait while the Raspberry Pi reconnects.";
  } catch (error) {
    throw new Error(`Failed to update WiFi configuration. ${error}`);
  }
}

function getPrinter() {
  const devices = usb.getDeviceList();
  const printers = devices.filter((device) => {
    const descriptor = device.deviceDescriptor;
    return (
      descriptor.idVendor === 4070 &&
      descriptor.idProduct === 33054 &&
      descriptor.bcdDevice === 256
    );
  });

  if (printers.length > 0) {
    return printers[0];
  } else {
    throw new Error("No printers found");
  }
}

async function getImage({
  pictureUrl,
  width,
  height,
  rotate = 0,
}: {
  pictureUrl: string;
  width: number;
  height: number;
  rotate?: number;
}) {
  const response = await fetch(pictureUrl);

  if (!response.ok) {
    throw new Error("Failed to fetch picture");
  }

  const imageBuffer = await response.arrayBuffer();
  const processedImageBuffer = await sharp(imageBuffer)
    .rotate(rotate)
    .resize(width, height)
    .toBuffer();

  const img = new Image();
  img.src = processedImageBuffer;

  return img;
}

async function printWithLAN(pictureUrl: any) {
  const PRINTER_IP = "192.168.0.87";
  const PRINTER_PORT = 9100;
  const client = new net.Socket();
  console.log("Created socket");

  await new Promise((resolve, reject) => {
    client.connect(PRINTER_PORT, PRINTER_IP, async function () {
      console.log("Connected to the printer");
      try {
        let result = await encodePrintData({ pictureUrl });
        if (!result) {
          throw new Error("Failed to encode print data");
        }

        client.write(result, () => {
          client.end(() => {
            console.log("Connection closed");
            resolve("done");
          });
        });
      } catch (error) {
        client.end(() => {
          console.error("Failed to encode print data:", error);
          reject("Failed to encode print data");
        });
      }
    });

    client.on("error", (error) => {
      console.error("Connection error:", error);
      reject("Connection error");
    });
  });

  console.log("Data sent and connection closed");
}

async function printImage({
  method,
  pictureUrl,
  texts,
}: {
  method: string;
  pictureUrl?: string;
  texts?: string[];
}) {
  if (method === "lan") {
    return await printWithLAN(pictureUrl);
  } else {
    return await printWithUSB({ pictureUrl, texts });
  }
}

app.post("/print", async (req, res) => {
  console.log("Printing");

  const { pictureUrl, texts } = req.query as {
    pictureUrl?: string;
    texts?: string;
  };

  try {
    const result = await printImage({
      method: "usb",
      pictureUrl,
      texts: texts?.split(","),
    });
    res.json({
      status: "success",
      message: "Print job completed successfully",
      result: result,
    });
  } catch (error: any) {
    res.status(500).json({
      status: "error",
      message: error.message,
    });
  }
});

app.get("/scan_wifi", async (req, res) => {
  try {
    const { stdout } = await execCommand("sudo nmcli -t -f SSID dev wifi");
    const ssids = stdout.split("\n").filter((ssid) => ssid);
    res.json({ ssids });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/current_wifi", (req, res) => {
  exec(
    "nmcli -t -f active,ssid dev wifi | egrep '^yes' | cut -d: -f2",
    (error, stdout, stderr) => {
      if (error) {
        console.error(`exec error: ${error}`);
        return res.status(500).json({ error: "Failed to get current SSID" });
      }
      const currentSSID = stdout.trim();
      res.json({ ssid: currentSSID });
    }
  );
});

app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>WiFi Config</title>
    </head>
    <body>
        <h1>WiFi Configuration</h1>
        <p>Currently connected to: <span id="current-ssid">Loading...</span></p>
        <form method="POST" action="/update_wifi">
            <label for="ssid">WiFi SSID:</label><br>
            <select id="ssid" name="ssid">
                <option value="">Select a WiFi network</option>
            </select><br><br>
            <label for="psk">WiFi Password:</label><br>
            <input type="password" id="psk" name="psk"><br><br>
            <input type="submit" value="Submit">
        </form>
        <script>
            async function fetchWiFiNetworks() {
                try {
                    const response = await fetch('/scan_wifi');
                    const data = await response.json();
                    const ssidSelect = document.getElementById('ssid');
                    data.ssids.forEach(ssid => {
                        const option = document.createElement('option');
                        option.value = ssid;
                        option.textContent = ssid;
                        ssidSelect.appendChild(option);
                    });
                } catch (error) {
                    console.error('Failed to fetch WiFi networks:', error);
                }
            }

            async function fetchCurrentSSID() {
                try {
                    const response = await fetch('/current_wifi');
                    const data = await response.json();
                    document.getElementById('current-ssid').textContent = data.ssid;
                } catch (error) {
                    console.error('Failed to fetch current SSID:', error);
                }
            }

            fetchWiFiNetworks();
            fetchCurrentSSID();
        </script>
    </body>
    </html>
  `);
});

app.get("/menu", (req, res) => {
  const filePath = path.join(__dirname, "../src/menu.html");
  fs.readFile(filePath, "utf8", (err, data) => {
    if (err) {
      res.status(500).send("Error reading the HTML file");
      return;
    }
    res.send(data);
  });
});

// @ts-ignore
app.post("/update_wifi", async (req, res) => {
  console.log("Updating WiFi configuration");
  console.log(JSON.stringify(req.body));

  const ssid = req.body.ssid;
  const psk = req.body.psk;

  if (!ssid || !psk) {
    return res.send("Please provide both SSID and password.");
  }

  try {
    const message = await updateWifiConfig(ssid, psk);
    res.send(message);
  } catch (error: any) {
    res.status(500).send({ error: error.message });
  }
});

app.listen(port, () => {
  console.log(`Printer server running on port ${port}`);
});
