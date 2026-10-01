import { Config } from "@remotion/cli/config";

// Frames are captured as PNG so text and the dark gradients are not
// JPEG-compressed before H.264 encoding.
Config.setVideoImageFormat("png");
Config.setCodec("h264");
Config.setPixelFormat("yuv420p");
Config.setColorSpace("bt709");
Config.setCrf(18);
Config.setX264Preset("slow");
Config.setMuted(true);
Config.setOverwriteOutput(true);
