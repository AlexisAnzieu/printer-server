import express from 'express'
import net from "net";
import EscPosEncoder from "esc-pos-encoder";
import sharp from "sharp";
import { Image } from "canvas";

const app = express()
const port = 9100
const PICTURE_WIDTH = 528;
const PICTURE_HEIGHT = 712;
const LOGO_WIDTH = 200;
const LOGO_HEIGHT = 200;
const PRINTER_IP = "192.168.0.87";
const PRINTER_PORT = 9100;


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

const printImage = async (pictureUrl) => {
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
}

app.get('/print', async (req, res) => {
    console.log("Printing");

    const { pictureUrl } = req.query

    if (!pictureUrl) {
        return res.send('invalid pictureUrl')
    }

    await printImage(pictureUrl);

    res.send('printed')
})

app.listen(port, () => {
    console.log(`Example app listening on port ${port}`)
})