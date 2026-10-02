<script setup lang="ts">
// Ikon Material (Iconify) yang dibundel OFFLINE — tidak mengambil dari
// internet saat dipakai di lokasi lomba. Tambahkan ikon baru di ICONS.
import { Icon } from "@iconify/vue";
import add from "@iconify-icons/ic/baseline-add";
import arrowBack from "@iconify-icons/ic/baseline-arrow-back";
import camera from "@iconify-icons/ic/baseline-videocam";
import check from "@iconify-icons/ic/baseline-check-circle";
import chevron from "@iconify-icons/ic/baseline-chevron-right";
import close from "@iconify-icons/ic/baseline-close";
import del from "@iconify-icons/ic/baseline-delete-outline";
import doneAll from "@iconify-icons/ic/baseline-done-all";
import down from "@iconify-icons/ic/baseline-keyboard-arrow-down";
import edit from "@iconify-icons/ic/baseline-edit";
import error from "@iconify-icons/ic/baseline-error-outline";
import finish from "@iconify-icons/ic/baseline-sports-score";
import focus from "@iconify-icons/ic/baseline-center-focus-strong";
import grid from "@iconify-icons/ic/baseline-grid-on";
import groups from "@iconify-icons/ic/baseline-groups";
import history from "@iconify-icons/ic/baseline-history";
import info from "@iconify-icons/ic/baseline-info";
import level from "@iconify-icons/ic/baseline-horizontal-rule";
import lock from "@iconify-icons/ic/baseline-lock";
import logout from "@iconify-icons/ic/baseline-logout";
import pending from "@iconify-icons/ic/baseline-pending";
import person from "@iconify-icons/ic/baseline-person";
import play from "@iconify-icons/ic/baseline-play-arrow";
import refresh from "@iconify-icons/ic/baseline-refresh";
import ruler from "@iconify-icons/ic/baseline-straighten";
import search from "@iconify-icons/ic/baseline-search";
import sensors from "@iconify-icons/ic/baseline-sensors";
import stop from "@iconify-icons/ic/baseline-stop";
import target from "@iconify-icons/ic/baseline-gps-fixed";
import timer from "@iconify-icons/ic/baseline-timer";
import touch from "@iconify-icons/ic/baseline-touch-app";
import tune from "@iconify-icons/ic/baseline-tune";
import vertical from "@iconify-icons/ic/baseline-vertical-align-center";
import verified from "@iconify-icons/ic/baseline-verified";
import warning from "@iconify-icons/ic/baseline-warning-amber";
import water from "@iconify-icons/ic/baseline-water";
import wifi from "@iconify-icons/ic/baseline-wifi";
import wifiOff from "@iconify-icons/ic/baseline-wifi-off";
import zoom from "@iconify-icons/ic/baseline-zoom-in";
import laptop from "@iconify-icons/ic/baseline-laptop-mac";
import iphone from "@iconify-icons/ic/baseline-phone-iphone";
import usb from "@iconify-icons/ic/baseline-usb";
import ipcam from "@iconify-icons/ic/baseline-wifi-tethering";
import movie from "@iconify-icons/ic/baseline-movie";
import settings from "@iconify-icons/ic/baseline-settings";
import restart from "@iconify-icons/ic/baseline-restart-alt";
import save from "@iconify-icons/ic/baseline-save";
import volume from "@iconify-icons/ic/baseline-volume-up";
import volumeOff from "@iconify-icons/ic/baseline-volume-off";
import compare from "@iconify-icons/ic/baseline-compare";
import skipNext from "@iconify-icons/ic/baseline-skip-next";

const ICONS = {
  add, arrowBack, camera, check, chevron, close, del, doneAll, down, edit, error, finish, focus, grid, groups, history,
  info, level, lock, logout, pending, person, play, refresh, ruler, search, sensors, stop, target, timer, touch, tune,
  vertical, verified, warning, water, wifi, wifiOff, zoom,
  laptop, iphone, usb, ipcam, movie, settings, restart, save, volume, volumeOff, compare, skipNext,
} as const;
export type IconName = keyof typeof ICONS;

defineProps<{ name: IconName; size?: number | string }>();
</script>

<template>
  <Icon :icon="ICONS[name]" class="iconify" :width="size ?? '1.15em'" :height="size ?? '1.15em'" aria-hidden="true" />
</template>
