export CKPT=./models/LFM2.5-Audio
mkdir -p $CKPT
hf download LiquidAI/LFM2.5-Audio-1.5B-GGUF \
LFM2.5-Audio-1.5B-Q4_0.gguf mmproj-LFM2.5-Audio-1.5B-Q4_0.gguf \
vocoder-LFM2.5-Audio-1.5B-Q4_0.gguf tokenizer-LFM2.5-Audio-1.5B-Q4_0.gguf \
--local-dir $CKPT

hf download LiquidAI/LFM2.5-Audio-1.5B-GGUF \
  runners/llama-liquid-audio-macos-arm64.zip \
  --local-dir $CKPT

unzip $CKPT/runners/llama-liquid-audio-macos-arm64.zip -d $CKPT/bin/
chmod +x $CKPT/bin/llama-liquid-audio-macos-arm64/llama-liquid-audio-server $CKPT/bin/llama-liquid-audio-macos-arm64/llama-liquid-audio-cli

xattr -dr com.apple.quarantine $CKPT/bin/