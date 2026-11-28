#!/usr/bin/env python3
"""Encode two variants of a short local H.264 clip. Requires ffmpeg 6+ (libx264) and ffprobe."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import statistics
import subprocess
import sys
import tempfile


def run(args, cwd=None):
    process = subprocess.run(args, cwd=cwd, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=600)
    if process.returncode:
        raise ValueError(process.stderr.strip()[-1500:] or f"{args[0]} a échoué.")
    return process.stdout


def probe(path, *args):
    return json.loads(run(["ffprobe", "-v", "error", "-protocol_whitelist", "file", "-format_whitelist", "mov",
                           *args, "-of", "json", "-i", str(path)]))


def digest(path):
    sha = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            sha.update(block)
    return sha.hexdigest()


def inspect(path):
    info = probe(path, "-show_format", "-show_streams", "-show_chapters")
    streams = info["streams"]
    videos = [s for s in streams if s["codec_type"] == "video"]
    if len(videos) != 1 or any(s["codec_name"] != "aac" for s in streams if s not in videos):
        raise ValueError("Format accepté : une piste vidéo H.264 et, éventuellement, des pistes audio AAC.")
    video = videos[0]
    if (info.get("chapters") or video["codec_name"] != "h264" or video.get("pix_fmt") != "yuv420p"
            or video.get("field_order", "progressive") not in ("progressive", "unknown")
            or any(s.get("side_data_list") or s.get("disposition", {}).get("attached_pic") for s in streams)
            or video.get("closed_captions") or video.get("film_grain")
            or video.get("color_transfer") in ("smpte2084", "arib-std-b67")):
        raise ValueError("Cet essai accepte les clips H.264 SDR progressifs, sans chapitre, rotation ou piste annexe.")
    duration = float(info["format"].get("duration", 0))
    if not 0 < duration <= 120:
        raise ValueError("Choisissez un extrait d’une durée maximale de deux minutes.")
    raw = probe(path, "-select_streams", "v:0", "-show_frames", "-show_entries",
                "frame=best_effort_timestamp_time:frame_side_data=side_data_type")["frames"]
    if not raw or any(not f.get("best_effort_timestamp_time") for f in raw):
        raise ValueError("Chronologie vidéo illisible.")
    for frame in raw:
        for extra in frame.get("side_data_list", []):
            if "User Data Unregistered SEI" not in extra.get("side_data_type", ""):
                raise ValueError("La vidéo signale des données d’image supplémentaires non prises en charge.")
    audio = probe(path, "-select_streams", "a", "-show_packets", "-show_data_hash", "sha256",
                  "-show_entries", "packet=stream_index,pts_time,duration_time,size,data_hash:packet_side_data").get("packets", [])
    return info, [float(f["best_effort_timestamp_time"]) for f in raw], audio


def keep_tags(source, target, ignored):
    for key, value in source.get("tags", {}).items():
        if key not in ignored and value != target.get("tags", {}).get(key):
            raise ValueError(f"La métadonnée {key} a changé.")


def compare(original, candidate):
    before, original_times, original_audio = original
    after, new_times, new_audio = candidate
    if len(original_times) != len(new_times) or len(before["streams"]) != len(after["streams"]):
        raise ValueError("Le nombre d’images ou de pistes a changé.")
    drift = max(abs(a - b) for a, b in zip(original_times, new_times))
    if drift > 0.001001:
        raise ValueError("Les horodatages vidéo ont changé de plus d’une milliseconde.")
    if original_audio != new_audio:
        raise ValueError("Le contenu ou les horodatages des paquets audio ont changé.")
    for old, new in zip(before["streams"], after["streams"]):
        keys = ("codec_type", "codec_name", "width", "height", "pix_fmt", "channels", "sample_rate",
                "channel_layout", "disposition", "color_space", "color_transfer", "color_primaries")
        if any(old.get(k) != new.get(k) for k in keys):
            raise ValueError("Les propriétés de piste ont changé.")
        for key in ("sample_aspect_ratio", "display_aspect_ratio", "color_range", "chroma_location"):
            if old.get(key, "unknown") not in ("unknown", "N/A") and old.get(key) != new.get(key):
                raise ValueError(f"La propriété {key} a changé.")
        keep_tags(old, new, {"encoder", "vendor_id"})
        if abs(float(old["duration"]) - float(new["duration"])) > 0.05:
            raise ValueError("La durée d’une piste a changé de plus de 50 ms.")
    keep_tags(before["format"], after["format"], {"encoder", "major_brand", "minor_version", "compatible_brands"})
    if abs(float(before["format"]["duration"]) - float(after["format"]["duration"])) > 0.05:
        raise ValueError("La durée du conteneur a changé de plus de 50 ms.")
    return drift


def build_variant(source, directory, quality, original, byte_limit, min_ssim_y):
    target = directory / f"variante-crf{quality}.mp4"
    draft = directory / f"encodage-crf{quality}.part.mp4"
    log = f"ssim-crf{quality}.log"
    base = ["ffmpeg", "-hide_banner", "-nostdin", "-v", "error", "-xerror", "-n"]
    local = ["-protocol_whitelist", "file", "-format_whitelist", "mov", "-noautorotate", "-i"]
    run([*base, *local, str(source), "-map", "0", "-map_metadata", "0", "-map_chapters", "0", "-c", "copy",
         "-c:v:0", "libx264", "-threads:v", "4", "-preset", "medium", "-crf", str(quality),
         "-fps_mode:v", "passthrough", "-enc_time_base:v", "demux", "-movflags", "+faststart+use_metadata_tags",
         str(draft)])
    drift = compare(original, inspect(draft))
    # Both full video tracks feed SSIM; both sets of audio tracks are decoded into the null muxer.
    run([*base, *local, str(source), *local, str(draft), "-filter_complex_threads", "2", "-filter_complex",
         f"[0:v:0][1:v:0]ssim=stats_file={log}:shortest=1[score]", "-map", "[score]", "-map", "0:a?", "-map", "1:a?",
         "-f", "null", "-"], cwd=directory)
    pairs = re.findall(r"\bY:(\S+).*?\bAll:(\S+)", (directory / log).read_text())
    if len(pairs) != len(original[1]):
        raise ValueError("La mesure SSIM ne couvre pas toutes les images.")
    luminance = [float(y) for y, _ in pairs]
    scores = [float(score) for _, score in pairs]
    if not all(math.isfinite(s) for s in scores + luminance):
        raise ValueError("Une mesure SSIM est inexploitable.")
    mean_y = statistics.mean(luminance)
    draft.rename(target)
    return {"file": target.name, "sha256": digest(target), "bytes": target.stat().st_size,
            "sizeGoalMet": target.stat().st_size <= byte_limit, "crf": quality, "framesCompared": len(scores),
            "maxVideoTimestampDifferenceMs": round(drift * 1000, 4),
            "ssimMean": statistics.mean(scores), "ssimMinimum": min(scores),
            "ssimYMean": mean_y, "ssimYMinimum": min(luminance), "qualityGoalMet": mean_y >= min_ssim_y,
            "verified": True}


def main():
    parser = argparse.ArgumentParser(description="Préparer deux variantes locales MP4 et leur rapport de mesure.")
    parser.add_argument("video", type=Path)
    parser.add_argument("--output-parent", type=Path, help="Dossier parent existant (par défaut à côté de la vidéo).")
    parser.add_argument("--prefer", choices=("quality", "size"), default="quality",
                        help="Parmi les variantes admissibles, préférer le meilleur SSIM global ou le poids minimal.")
    parser.add_argument("--min-ssim-y", type=float, default=0.98,
                        help="SSIM moyen minimal de luminance requis, entre 0 et 1 (défaut : 0.98).")
    args = parser.parse_args()
    if not math.isfinite(args.min_ssim_y) or not 0 <= args.min_ssim_y <= 1:
        parser.error("--min-ssim-y doit être une valeur finie entre 0 et 1.")
    source = args.video.resolve(strict=True)
    if not source.is_file():
        raise ValueError("Choisissez un fichier vidéo local.")
    original = inspect(source)
    directory = Path(tempfile.mkdtemp(prefix="iao-essai-", dir=(args.output_parent or source.parent).resolve()))
    size = source.stat().st_size
    source_hash = digest(source)
    byte_limit = size * 2 // 3
    info, times, packets = original
    report = {"source": source.name, "sourceSha256": source_hash, "sourceBytes": size,
              "sourceDurationSeconds": float(info["format"]["duration"]), "frames": len(times),
              "audioStreams": sum(s["codec_type"] == "audio" for s in info["streams"]), "audioPackets": len(packets),
              "maxBytes": byte_limit, "minSsimY": args.min_ssim_y, "prefer": args.prefer, "variants": [],
              "status": "incomplete", "decisionStatus": "not_evaluated", "recommendedFile": None,
              "scope": "Contrôle du décodage, de la chronologie, des paquets audio et SSIM sur chaque image. "
                       "Les informations privées d’encodage SEI et les métadonnées propres au conteneur ou à l’encodeur peuvent changer. "
                       "La qualité perçue reste à examiner dans le lecteur."}
    path = directory / "rapport.json"
    print(f"Dossier de l’essai : {directory}", flush=True)
    try:
        for quality in (22, 28):
            report["variants"].append(build_variant(source, directory, quality, original, byte_limit, args.min_ssim_y))
        if digest(source) != source_hash:
            raise ValueError("Le fichier source a changé durant l’essai.")
        eligible = [v for v in report["variants"] if v["sizeGoalMet"] and v["qualityGoalMet"]]
        if eligible:
            def order(variant):
                quality_first = (-variant["ssimMean"], variant["bytes"])
                return quality_first if args.prefer == "quality" else quality_first[::-1]
            report["recommendedFile"] = min(eligible, key=order)["file"]
            report["decisionStatus"] = "recommended"
            print(f"Variante retenue : {report['recommendedFile']}")
        else:
            report["decisionStatus"] = "no_candidate_meets_criteria"
            print("Mesures terminées : aucune variante admissible.")
        report["status"] = "verified"
    except KeyboardInterrupt:
        report["error"] = "Essai interrompu."
        raise
    except (ValueError, OSError, KeyError, subprocess.TimeoutExpired) as exc:
        report["error"] = str(exc)
        raise
    finally:
        path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        print(path)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, OSError, KeyError, subprocess.TimeoutExpired) as error:
        print(f"Essai interrompu : {error}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        sys.exit(130)
