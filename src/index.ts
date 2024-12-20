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
import { handleRawPrint } from "./handlers/rawPrint";

type PrintParams = {
  pictureUrl?: string;
  texts?: string[];
  logoUrl?: string;
};

const execCommand = util.promisify(exec);

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

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

async function encodePrintData({ pictureUrl, texts, logoUrl }: PrintParams) {
  const PICTURE_WIDTH = 528;
  const PICTURE_HEIGHT = 712;
  const LOGO_WIDTH = 200;
  const LOGO_HEIGHT = 200;

  // @ts-ignore
  let encoder = new EscPosEncoder({
    createCanvas,
  });
  try {
    encoder = encoder.initialize().align("center");

    if (logoUrl) {
      encoder = encoder
        .image(
          await getImage({
            pictureUrl: logoUrl,
            width: LOGO_WIDTH,
            height: LOGO_HEIGHT,
          }),
          LOGO_WIDTH,
          LOGO_HEIGHT,
          "atkinson"
        )
        .newline();
    }
    if (pictureUrl) {
      encoder = encoder.image(
        await getImage({
          pictureUrl,
          width: PICTURE_WIDTH,
          height: PICTURE_HEIGHT,
          rotate: 90,
        }),
        PICTURE_WIDTH,
        PICTURE_HEIGHT,
        "atkinson"
      );
    }

    if (texts) {
      texts.map((text) => encoder.line(text));
    }

    if (texts?.[0] === "qr") {
      encoder = encoder.qrcode(QR_CODE_URL, 2, 8, "h");
    }

    return encoder.newline().newline().newline().newline().cut().encode();
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
  data,
}: {
  posPrinter: {
    endpoint: usb.OutEndpoint;
    iface: usb.Interface;
    printer: usb.usb.Device;
  };
  data: Uint8Array;
}) {
  console.log("Printing...");

  return new Promise((resolve, reject) => {
    posPrinter.endpoint.transfer(data as Buffer, (error: any) => {
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

async function printWithUSB({ pictureUrl, texts, logoUrl }: PrintParams) {
  const posPrinter = initializePrinter();
  if (!posPrinter) {
    throw new Error("Failed to initialize printer");
  }

  let result = await encodePrintData({ pictureUrl, texts, logoUrl });
  if (!result) {
    posPrinter.printer.close();
    throw new Error("Failed to encode print data");
  }

  return await transferToEndpoint({ posPrinter, data: result });
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
  logoUrl,
}: PrintParams & { method: "usb" | "lan" }) {
  if (method === "lan") {
    return await printWithLAN(pictureUrl);
  } else {
    return await printWithUSB({ pictureUrl, texts, logoUrl });
  }
}

export async function printRawData(data: Buffer) {
  const posPrinter = initializePrinter();
  if (!posPrinter) {
    throw new Error("Failed to initialize printer");
  }

  return await transferToEndpoint({ posPrinter, data });
}

app.post("/print", async (req, res) => {
  console.log("Printing");

  const { pictureUrl, texts, logoUrl } = req.body as PrintParams;

  try {
    const result = await printImage({
      method: "usb",
      pictureUrl,
      texts,
      logoUrl,
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

app.post("/raw-print", handleRawPrint);

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

app.get("/refresh", (req, res) => {
  exec(
    "cd /home/printer/printer-server && npm run refresh",
    (error, stdout, stderr) => {
      if (error) {
        console.error(`exec error: ${error}`);
        return res.status(500).json({ error: "Failed refresh server" });
      }
      res.json({ sucess: true });
    }
  );
});

app.get("/logs", (req, res) => {
  exec(" pm2 logs 0 --lines 15 --raw  --nostream", (error, stdout, stderr) => {
    if (error) {
      console.error(`exec error: ${error}`);
      return res.status(500).json({ error: "Failed to fetch logs" });
    }
    try {
      const logs = stdout.split("\n");
      res.json(logs);
    } catch (parseError) {
      console.error(`parse error: ${parseError}`);
      res.status(500).json({ error: "Failed to parse logs" });
    }
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

app.use("/", express.static(path.join(__dirname, "../public")));

app.get("/version", (req, res) => {
  fs.readFile(path.join(__dirname, "../package.json"), "utf8", (err, data) => {
    if (err) {
      res.status(500).send({ error: "Failed to read version" });
      return;
    }
    const packageJson = JSON.parse(data);
    res.send({ version: packageJson.version });
  });
});

app.listen(port, () => {
  console.log(`Printer server running on port ${port}`);
});
