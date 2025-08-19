# 3D-HSV-Color-Visualizer

An interactive web-based tool to **visualize the HSV (Hue, Saturation, Value) color space in 3D as an inverted cone**.  
It allows you to explore colors by adjusting sliders for Hue, Saturation, and Value, while viewing a rotatable 3D model and a live preview of the selected color.
- Click [3D HSV Color Visualizer](https://matinmonshizadeh.github.io/3D-HSV-Color-Visualizer/) to run it!

![Cone](https://github.com/user-attachments/assets/d88f1a75-dc37-4f99-a207-dbad17d21445)


## 📖 Description

The HSV color model is represented as a **cone**:

- **Hue (H):** wraps around the base of the cone (circular dimension).  
- **Saturation (S):** extends radially from the center (low saturation in the middle, high at the edges).  
- **Value (V):** runs vertically along the height (bright at the top, dark at the bottom).

<img width="1536" height="1024" alt="image" src="https://github.com/user-attachments/assets/ee134791-832e-44eb-a853-51385de02e80" />

The visualization uses **HTML Canvas** for rendering the 3D cone with basic perspective projection.  
You can drag the mouse on the canvas to rotate the view.  

The tool also supports **two hue modes**:
- Standard degrees (**0–360**)  
- OpenCV-style range (**0–179**)  

This project is built with **pure JavaScript** (no external libraries) and runs in any modern browser.

---

## ✨ Features

- 🌀 Interactive 3D cone visualization of HSV color space  
- 🎚️ Sliders for adjusting **Hue (H)**, **Saturation (S)**, and **Value (V)**  
- 🔄 Support for **Hue in degrees (0–360)** or **OpenCV range (0–179)**  
- 🎨 Real-time **color preview box** with RGB and HEX code  
- 🖱️ Mouse-drag rotation for orbiting the 3D view  
- 🧭 Labeled axes for Value, Saturation, and Hue  
- 📍 Marker indicating the currently selected color on the cone  

---

## 🚀 Usage

1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/3d-hsv-visualizer.git
