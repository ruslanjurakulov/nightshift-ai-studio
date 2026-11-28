"""PANNs Cnn14, inference only. Vendored from two MIT projects by Qiuqiang Kong (LICENSE in this directory):

* ``ConvBlock`` and ``Cnn14`` from audioset_tagging_cnn ``pytorch/models.py`` (commit d2f4b8c18eab44737fcc0de1248ae21eb43f6aa4);
* ``STFT``, ``Spectrogram`` and ``LogmelFilterBank`` from torchlibrosa ``torchlibrosa/stft.py`` (commit
  d4e8add6c9ee49ae531c78a4901e4fdcc88c746a).

Changes from upstream, and why:
* The DFT kernels and the mel matrix are created as ZERO parameters of the upstream shapes instead of being computed with
  librosa. Both are saved in the Cnn14 checkpoint, so ``load_state_dict(strict=True)`` fills them with the exact values the
  model was trained with, and a checkpoint without them fails to load (it can never run on zeros). This drops librosa, numba
  and llvmlite from the measurement install.
* Training-only paths (SpecAugment, mixup, dropout) are removed: the model is only ever evaluated here, in ``eval()`` mode,
  where upstream skips them too.
* Weight initialisation is removed: every parameter comes from the checkpoint.

The weights (Zenodo record 3987831, ``Cnn14_mAP=0.431.pth``) are licensed CC BY 4.0 and are NOT in this repository;
``tools/vocal_activity.py`` downloads them by a pinned URL and sha256. Attribution: THIRD_PARTY_NOTICES.
"""

from __future__ import annotations

import torch
import torch.nn as nn
import torch.nn.functional as F

#: The settings the checkpoint was trained with (audioset_tagging_cnn README, "Cnn14_mAP=0.431.pth").
SAMPLE_RATE = 32000
WINDOW_SIZE = 1024
HOP_SIZE = 320
MEL_BINS = 64
FMIN = 50
FMAX = 14000
CLASSES_NUM = 527


class STFT(nn.Module):
    def __init__(self, n_fft: int, hop_length: int):
        super().__init__()
        self.n_fft = n_fft
        out_channels = n_fft // 2 + 1
        self.conv_real = nn.Conv1d(1, out_channels, kernel_size=n_fft, stride=hop_length, padding=0, bias=False)
        self.conv_imag = nn.Conv1d(1, out_channels, kernel_size=n_fft, stride=hop_length, padding=0, bias=False)
        nn.init.zeros_(self.conv_real.weight)
        nn.init.zeros_(self.conv_imag.weight)
        for p in self.parameters():
            p.requires_grad = False

    def forward(self, x):
        x = x[:, None, :]
        x = F.pad(x, pad=(self.n_fft // 2, self.n_fft // 2), mode="reflect")
        real = self.conv_real(x)[:, None, :, :].transpose(2, 3)
        imag = self.conv_imag(x)[:, None, :, :].transpose(2, 3)
        return real, imag


class Spectrogram(nn.Module):
    def __init__(self, n_fft: int, hop_length: int):
        super().__init__()
        self.stft = STFT(n_fft, hop_length)

    def forward(self, x):
        real, imag = self.stft(x)
        return real ** 2 + imag ** 2


class LogmelFilterBank(nn.Module):
    def __init__(self, n_fft: int, n_mels: int, amin: float = 1e-10):
        super().__init__()
        self.amin = amin
        self.melW = nn.Parameter(torch.zeros(n_fft // 2 + 1, n_mels), requires_grad=False)

    def forward(self, x):
        mel = torch.matmul(x, self.melW)
        # ref = 1.0 and top_db = None in Cnn14, so librosa's power_to_db reduces to this.
        return 10.0 * torch.log10(torch.clamp(mel, min=self.amin))


class ConvBlock(nn.Module):
    def __init__(self, in_channels: int, out_channels: int):
        super().__init__()
        self.conv1 = nn.Conv2d(in_channels, out_channels, kernel_size=(3, 3), stride=(1, 1), padding=(1, 1), bias=False)
        self.conv2 = nn.Conv2d(out_channels, out_channels, kernel_size=(3, 3), stride=(1, 1), padding=(1, 1), bias=False)
        self.bn1 = nn.BatchNorm2d(out_channels)
        self.bn2 = nn.BatchNorm2d(out_channels)

    def forward(self, x, pool_size=(2, 2)):
        x = F.relu_(self.bn1(self.conv1(x)))
        x = F.relu_(self.bn2(self.conv2(x)))
        return F.avg_pool2d(x, kernel_size=pool_size)


class Cnn14(nn.Module):
    def __init__(self):
        super().__init__()
        self.spectrogram_extractor = Spectrogram(WINDOW_SIZE, HOP_SIZE)
        self.logmel_extractor = LogmelFilterBank(WINDOW_SIZE, MEL_BINS)
        self.bn0 = nn.BatchNorm2d(64)
        self.conv_block1 = ConvBlock(1, 64)
        self.conv_block2 = ConvBlock(64, 128)
        self.conv_block3 = ConvBlock(128, 256)
        self.conv_block4 = ConvBlock(256, 512)
        self.conv_block5 = ConvBlock(512, 1024)
        self.conv_block6 = ConvBlock(1024, 2048)
        self.fc1 = nn.Linear(2048, 2048, bias=True)
        self.fc_audioset = nn.Linear(2048, CLASSES_NUM, bias=True)

    def forward(self, x):
        """``x``: (batch, samples) at 32 kHz mono. Returns (batch, 527) clip-wise probabilities."""
        x = self.spectrogram_extractor(x)
        x = self.logmel_extractor(x)
        x = x.transpose(1, 3)
        x = self.bn0(x)
        x = x.transpose(1, 3)
        x = self.conv_block1(x, pool_size=(2, 2))
        x = self.conv_block2(x, pool_size=(2, 2))
        x = self.conv_block3(x, pool_size=(2, 2))
        x = self.conv_block4(x, pool_size=(2, 2))
        x = self.conv_block5(x, pool_size=(2, 2))
        x = self.conv_block6(x, pool_size=(1, 1))
        x = torch.mean(x, dim=3)
        x1, _ = torch.max(x, dim=2)
        x2 = torch.mean(x, dim=2)
        x = F.relu_(self.fc1(x1 + x2))
        return torch.sigmoid(self.fc_audioset(x))
