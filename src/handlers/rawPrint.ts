import { Request, Response } from "express";
import { printRawData } from "..";

export const handleRawPrint = (req: Request, res: Response): void => {
  const chunks: Buffer[] = [];

  req.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
  });

  req.on("end", async () => {
    const data = Buffer.concat(chunks);

    // Here you can process the raw data
    // The content type is 'application/octet-stream' and length is 42067 bytes

    try {
      // Process the data here
      // For example: send it to a printer

      const result = await printRawData(data);
      console.log(result);

      res.status(200).send("Print data received successfully");
    } catch (error) {
      console.error("Error processing print data:", error);
      res.status(500).send("Error processing print data");
    }
  });

  req.on("error", (error) => {
    console.error("Error receiving data:", error);
    res.status(500).send("Error receiving data");
  });
};
