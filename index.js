import express from 'express'
import net from "net";
import EscPosEncoder from "esc-pos-encoder";
import sharp from "sharp";
import { Image } from "canvas";
import usb from "usb";
import { exec } from "child_process";

const app = express()
app.use(express.urlencoded({ extended: true }));


const port = 9100
const PICTURE_WIDTH = 528;
const PICTURE_HEIGHT = 712;
const LOGO_WIDTH = 200;
const LOGO_HEIGHT = 200;
const PRINTER_IP = "192.168.0.87";
const PRINTER_PORT = 9100;

const execCommand = (command) => {
    return new Promise((resolve, reject) => {
        console.log(command)
        exec(command, (err, stdout, stderr) => {
            if (err) {
                reject(stderr);
            } else {
                resolve(stdout);
            }
        });
    });
};

function initializePrinter() {
    console.log("Printing with USB");
    const printer = getPrinter();

    try {
        printer.open();
        console.log('printer opened');
    } catch (err) {
        console.error('Failed to open printer:', err);
        return null;
    }

    return printer;
}

function encodePrintData() {
    let encoder = new EscPosEncoder();
    try {
        return encoder
            .initialize()
            .align('center')
            .qrcode('https://flyprint.vercel.app/ba620907-b377-4880-bedf-3e515722149e', 2, 8)
            .newline()
            .newline()
            .line('Le Plateau - Montreal')
            .newline()
            .newline()
            .newline()
            .newline()
            .newline()
            .newline()
            .cut()
            .encode();
    } catch (err) {
        console.error('Failed to encode print data:', err);
        return null;
    }
}

function claimInterface(iface) {
    try {
        iface.claim();
        console.log('interface claimed');
    } catch (err) {
        iface.detachKernelDriver();
        console.error('Failed to claim interface:', err);
        return false;
    }
    return true;
}

async function transferToEndpoint(endpoint, result, iface, printer) {
    return new Promise((resolve, reject) => {
        if (!Buffer.isBuffer(result)) {
            result = Buffer.from(result);
        }

        console.log('printing...');

        return endpoint.transfer(result, (error) => {
            if (error) {
                console.error('Print failed', error);
                reject('Print failed');
            } else {
                console.log('Print successful');
                resolve('Print successful');
            }

            return iface.release(() => printer.close());
        });
    });
}

async function printWithUSB() {
    return new Promise(async (resolve, reject) => {
        const printer = initializePrinter();
        if (!printer) return reject('Failed to initialize printer');

        const result = encodePrintData();
        if (!result) {
            printer.close();
            return reject('Failed to encode print data');
        }

        const iface = printer.interfaces[0];
        if (!claimInterface(iface)) {
            printer.close();
            return reject('Failed to claim interface');
        }

        const endpoint = iface.endpoints.find(ep => ep.direction === 'out');
        if (!endpoint || typeof endpoint.transfer !== 'function') {
            console.error('Invalid endpoint or transfer method');
            iface.release(() => printer.close());
            return reject('Invalid endpoint or transfer method');
        }

        return transferToEndpoint(endpoint, result, iface, printer)
            .then(resolve)
            .catch(reject);
    });
}


const updateWifiConfig = async (ssid, psk) => {
    try {
        // Add a new network
        const addNetworkOutput = await execCommand('sudo wpa_cli -i wlan0 add_network');
        const networkId = addNetworkOutput.trim();

        // Set the SSID and password
        await execCommand(`sudo wpa_cli -i wlan0 set_network ${networkId} ssid '"${ssid}"'`);
        await execCommand(`sudo wpa_cli -i wlan0 set_network ${networkId} psk '"${psk}"'`);

        // Enable the network
        await execCommand(`sudo wpa_cli -i wlan0 enable_network ${networkId}`);

        // Save the configuration
        await execCommand('sudo wpa_cli -i wlan0 save_config');

        // Reconfigure to apply changes
        await execCommand('sudo wpa_cli -i wlan0 reconfigure');

        // Restart the WiFi service to apply the new configuration
        await execCommand('sudo systemctl restart dhcpcd');

        return 'WiFi settings updated. Please wait while the Raspberry Pi reconnects.';
    } catch (error) {
        throw new Error(`Failed to update WiFi configuration. ${error}`);
    }
};

const getPrinter = () => {
    const devices = usb.getDeviceList();
    console.log(devices)
    const printers = devices.filter(device => {
        const descriptor = device.deviceDescriptor;

        return descriptor.idVendor === 4070 &&
            descriptor.idProduct === 33054 &&
            descriptor.bcdDevice === 256;
    });

    if (printers.length > 0) {
        return printers[0];
    } else {
        throw new Error('No printers found');
    }
}


const getImage = async ({ pictureUrl, width, height, rotate = 0 }) => {
    const response = await fetch(pictureUrl);
    const imageBuffer = await response.arrayBuffer();

    const processedImageBuffer = await sharp(imageBuffer)
        .rotate(rotate)
        .resize(width, height)
        .toBuffer();

    const img = new Image();
    img.src = processedImageBuffer;

    return img;
};

const printImage = async (pictureUrl, method) => {

    if (method === 'lan') {
        const client = new net.Socket();
        console.log("Created socket");

        await new Promise((resolve, reject) => {
            client.connect(PRINTER_PORT, PRINTER_IP, async function () {
                console.log("Connected to the printer");

                let encoder = new EscPosEncoder();

                // const logo = await getImage({ pictureUrl: 'https://res.cloudinary.com/dkbuiehgq/image/upload/v1713989859/session_1_zqo8jz.png', width: LOGO_WIDTH, height: LOGO_HEIGHT });
                const logo = await getImage({ pictureUrl: 'https://res.cloudinary.com/dkbuiehgq/image/upload/v1724450284/marie_30_abaenj.jpg', width: LOGO_WIDTH, height: LOGO_HEIGHT });
                const image = await getImage({ pictureUrl, width: PICTURE_WIDTH, height: PICTURE_HEIGHT, rotate: 90 });
                const date = new Date();
                const dateString = date.toLocaleString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

                let result = encoder
                    .initialize()
                    .align('center')
                    .image(logo, LOGO_WIDTH, LOGO_HEIGHT, "atkinson")
                    .newline()
                    .image(image, PICTURE_WIDTH, PICTURE_HEIGHT, "atkinson")
                    .newline()
                    .line(dateString)
                    .line('Le Plateau - Montreal')
                    .newline()
                    .newline()
                    .newline()
                    .newline()
                    .newline()
                    .newline()
                    .cut()
                    .encode();


                client.write(result, () => {
                    client.end(() => {
                        console.log("Connection closed");
                        resolve("done");
                    });
                });

            });
        });

        console.log("Data sent and connection closed");
    } else {
        try {
            return await printWithUSB();

        } catch (error) {
            return error;
        }

    }
}

app.get('/print', async (req, res) => {
    console.log("Printing");

    const { pictureUrl } = req.query

    try {
        const result = await printImage(pictureUrl, 'usb');
        console.log(result)
        return result;
    } catch (error) {
        res.status(500).send({ error: error })
    }
})

app.get('/', async (req, res) => {


    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Raspberry Pi WiFi Config</title>
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
      `)
})

app.get('/printer', async (req, res) => {
    const printer = getPrinter();

    res.send(printer)
})

app.post("/update_wifi", async (req, res) => {

    console.log("Updating WiFi configuration");
    console.log(JSON.stringify(req.body));

    const ssid = req?.body?.ssid;
    const psk = req?.body?.psk;

    if (!ssid || !psk) {
        return res.send("Please provide both SSID and password.");
    }

    try {
        const message = await updateWifiConfig(ssid, psk);
        res.send(message);
    } catch (error) {
        res.send(error.message);
    }
});

app.listen(port, () => {
    console.log(`Printer server ${port}`)
})