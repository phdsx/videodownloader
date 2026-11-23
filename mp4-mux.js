import {
  BlobSource, BufferTarget, EncodedAudioPacketSource, EncodedPacketSink,
  EncodedVideoPacketSource, Input, MP4, MPEG_TS, Mp4OutputFormat, Output,
} from "./vendor/mediabunny-1.66.2.js";

function openInput(blob) {
  return new Input({ formats: [MPEG_TS, MP4], source: new BlobSource(blob) });
}

async function writeTrack(track, source, decoderConfig, firstTimestamp) {
  const sink = new EncodedPacketSink(track);
  let first = true;
  for await (const packet of sink.packets()) {
    const adjusted = packet.clone({ timestamp: packet.timestamp - firstTimestamp });
    await source.add(adjusted, first ? { decoderConfig } : undefined);
    first = false;
  }
  if (first) throw new Error("音视频轨道没有可写入的数据。");
  source.close();
}

export async function remuxMp4(video, audio = null) {
  const main = openInput(video);
  const separateAudio = audio ? openInput(audio) : null;
  const target = new BufferTarget();
  const format = new Mp4OutputFormat({ fastStart: false });
  const output = new Output({ format, target });
  try {
    const [videoTracks, audioTracks] = await Promise.all([
      main.getVideoTracks(), (separateAudio || main).getAudioTracks(),
    ]);
    if (!videoTracks.length) throw new Error("没有找到可以封装为 MP4 的视频轨道。");
    if (separateAudio && !audioTracks.length) throw new Error("没有找到清单指定的独立音轨。");

    const tracks = [...videoTracks, ...audioTracks];
    const formats = format.getSupportedCodecs();
    const streams = await Promise.all(tracks.map(async (track) => {
      const [codec, decoderConfig, timestamp] = await Promise.all([
        track.getCodec(), track.getDecoderConfig(), track.getFirstTimestamp(),
      ]);
      if (!formats.includes(codec) || !decoderConfig || !Number.isFinite(timestamp)) {
        throw new Error("源视频的编码暂时无法在浏览器中封装为 MP4。");
      }
      return { track, codec, decoderConfig, timestamp };
    }));

    const firstTimestamp = Math.min(...streams.map((stream) => stream.timestamp));
    for (const stream of streams) {
      if (stream.track.type === "video") {
        stream.source = new EncodedVideoPacketSource(stream.codec);
        output.addVideoTrack(stream.source, { rotation: await stream.track.getRotation() });
      } else {
        stream.source = new EncodedAudioPacketSource(stream.codec);
        output.addAudioTrack(stream.source);
      }
    }
    await output.start();
    await Promise.all(streams.map(({ track, source, decoderConfig }) => {
      return writeTrack(track, source, decoderConfig, firstTimestamp);
    }));
    await output.finalize();
    return new Blob([target.buffer], { type: "video/mp4" });
  } catch (error) {
    await output.cancel();
    throw error;
  } finally {
    main.dispose();
    separateAudio?.dispose();
  }
}
