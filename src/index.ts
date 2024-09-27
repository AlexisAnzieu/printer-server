import express from "express";
import net from "net";
import EscPosEncoder from "esc-pos-encoder";
import sharp from "sharp";
import { Image } from "canvas";
import * as usb from "usb";
import { exec } from "child_process";
import util from "util";
import { createCanvas } from "canvas";

const execCommand = util.promisify(exec);

const app = express();
app.use(express.urlencoded({ extended: true }));

const port = 9100;
const QR_CODE_URL = "https://flyprint.vercel.app/nath";

function initializePrinter() {
  console.log("Init printer");
  const printer = getPrinter();

  try {
    printer.open();
    console.log("printer opened");
  } catch (err) {
    console.error("Failed to open printer:", err);
    return null;
  }

  return printer;
}

async function encodePrintData({ pictureUrl }: { pictureUrl?: string }) {
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
        "https://res.cloudinary.com/dkbuiehgq/image/upload/v1727450557/nath_4_f1no3e.png",
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
    iface.detachKernelDriver();
    console.error("Failed to claim interface:", err);
    return false;
  }
}

async function transferToEndpoint(
  endpoint: usb.OutEndpoint,
  result: Uint8Array,
  iface: usb.Interface,
  printer: usb.usb.Device
) {
  console.log("Printing...");

  return new Promise((resolve, reject) => {
    endpoint.transfer(result as Buffer, (error: any) => {
      if (error) {
        console.error("Print failed", error);
        reject("Print failed");
      } else {
        resolve("Print successful");
      }

      iface.release(() => printer.close());
    });
  });
}

async function printWithUSB({ pictureUrl }: { pictureUrl?: string }) {
  const printer = initializePrinter();
  if (!printer) {
    throw new Error("Failed to initialize printer");
  }

  let result = await encodePrintData({ pictureUrl });
  if (!result) {
    printer.close();
    throw new Error("Failed to encode print data");
  }

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

  return await transferToEndpoint(endpoint, result, iface, printer);
}

async function updateWifiConfig(ssid: any, psk: any) {
  try {
    const addNetworkOutput = await execCommand(
      "sudo wpa_cli -i wlan0 add_network"
    );
    const networkId = addNetworkOutput.stdout.trim();

    await execCommand(
      `sudo wpa_cli -i wlan0 set_network ${networkId} ssid '"${ssid}"'`
    );
    await execCommand(
      `sudo wpa_cli -i wlan0 set_network ${networkId} psk '"${psk}"'`
    );
    await execCommand(`sudo wpa_cli -i wlan0 enable_network ${networkId}`);
    await execCommand("sudo wpa_cli -i wlan0 save_config");
    await execCommand("sudo wpa_cli -i wlan0 reconfigure");
    await execCommand("sudo systemctl restart dhcpcd");

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

async function printImage(method: string, pictureUrl?: string) {
  if (method === "lan") {
    return await printWithLAN(pictureUrl);
  } else {
    return await printWithUSB({ pictureUrl });
  }
}

app.get("/print", async (req, res) => {
  console.log("Printing");

  const { pictureUrl } = req.query as {
    pictureUrl: string;
  };

  try {
    const result = await printImage("usb", pictureUrl);
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

app.get("/", (req, res) => {
  res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>WiFi Config</title>
        </head>
        <body>
            <h1>WiFi Configuration</h1>
            <form method="POST" action="/update_wifi">
                <label for="ssid">WiFi SSID:</label><br>
                <input type="text" id="ssid" name="ssid"><br><br>
                <label for="psk">WiFi Password:</label><br>
                <input type="password" id="psk" name="psk"><br><br>
                <input type="submit" value="Submit">
            </form>
        </body>
        </html>
    `);
});

app.get("/qr", (req, res) => {
  try {
    const printer = getPrinter();
    res.send(printer);
  } catch (error: any) {
    res.status(500).send({ error: error.message });
  }
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
