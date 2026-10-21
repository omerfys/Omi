using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public static class Program {
    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [STAThread]
    public static int Main(string[] args) {
        if (args.Length == 0) return 1;
        string outPath = args[0];

        try {
            SetProcessDPIAware();
        } catch {}

        try {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            using (var form = new SnipperForm(outPath)) {
                Application.Run(form);
                return form.Captured ? 0 : 2;
            }
        } catch {
            return 1;
        }
    }

    private class SnipperForm : Form {
        private readonly string outPath;
        private readonly Bitmap screenBmp;
        private Point startPoint;
        private Rectangle selection;
        private bool isSelecting = false;
        public bool Captured { get; private set; }

        public SnipperForm(string outPath) {
            this.outPath = outPath;
            this.DoubleBuffered = true;
            this.FormBorderStyle = FormBorderStyle.None;
            this.StartPosition = FormStartPosition.Manual;
            this.TopMost = true;
            this.ShowInTaskbar = false;
            this.Cursor = Cursors.Cross;

            Rectangle bounds = SystemInformation.VirtualScreen;
            this.Bounds = bounds;

            screenBmp = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format32bppArgb);
            using (Graphics g = Graphics.FromImage(screenBmp)) {
                g.CopyFromScreen(bounds.Location, Point.Empty, bounds.Size);
            }

            this.Shown += (s, e) => {
                this.Activate();
                this.BringToFront();
                this.Focus();
                SetForegroundWindow(this.Handle);
            };

            this.MouseDown += (s, e) => {
                if (e.Button == MouseButtons.Left) {
                    isSelecting = true;
                    this.Capture = true;
                    startPoint = e.Location;
                    selection = new Rectangle(e.X, e.Y, 0, 0);
                } else if (e.Button == MouseButtons.Right) {
                    this.Close();
                }
            };

            this.MouseMove += (s, e) => {
                if (isSelecting) {
                    int x0 = Math.Min(startPoint.X, e.X);
                    int y0 = Math.Min(startPoint.Y, e.Y);
                    int w = Math.Abs(e.X - startPoint.X);
                    int h = Math.Abs(e.Y - startPoint.Y);
                    selection = new Rectangle(x0, y0, w, h);
                    this.Invalidate();
                }
            };

            this.MouseUp += (s, e) => {
                if (isSelecting) {
                    isSelecting = false;
                    this.Capture = false;
                    Rectangle fullBounds = new Rectangle(0, 0, screenBmp.Width, screenBmp.Height);
                    Rectangle safeRect = Rectangle.Intersect(selection, fullBounds);

                    if (safeRect.Width > 5 && safeRect.Height > 5) {
                        try {
                            using (Bitmap cropped = new Bitmap(safeRect.Width, safeRect.Height, PixelFormat.Format32bppArgb)) {
                                using (Graphics g = Graphics.FromImage(cropped)) {
                                    g.DrawImage(screenBmp, 0, 0, safeRect, GraphicsUnit.Pixel);
                                }
                                cropped.Save(outPath, ImageFormat.Png);
                                try {
                                    Clipboard.SetImage(cropped);
                                } catch {}
                                Captured = true;
                            }
                        } catch {}
                    }
                    this.Close();
                }
            };

            this.KeyDown += (s, e) => {
                if (e.KeyCode == Keys.Escape) {
                    this.Close();
                }
            };
        }

        protected override void OnPaint(PaintEventArgs e) {
            Graphics g = e.Graphics;
            g.DrawImage(screenBmp, 0, 0);
            using (Brush darkBrush = new SolidBrush(Color.FromArgb(120, 0, 0, 0))) {
                g.FillRectangle(darkBrush, this.ClientRectangle);
            }

            if (selection.Width > 0 && selection.Height > 0) {
                Rectangle fullBounds = new Rectangle(0, 0, screenBmp.Width, screenBmp.Height);
                Rectangle safeRect = Rectangle.Intersect(selection, fullBounds);
                if (safeRect.Width > 0 && safeRect.Height > 0) {
                    g.DrawImage(screenBmp, safeRect, safeRect, GraphicsUnit.Pixel);
                }
                using (Pen pen = new Pen(Color.FromArgb(56, 189, 248), 2)) {
                    pen.DashStyle = DashStyle.Solid;
                    g.DrawRectangle(pen, selection);
                }

                string text = selection.Width + " x " + selection.Height;
                using (Font font = new Font("Segoe UI", 9, FontStyle.Bold))
                using (Brush badgeBg = new SolidBrush(Color.FromArgb(220, 15, 20, 28)))
                using (Brush textBrush = new SolidBrush(Color.White)) {
                    SizeF sz = g.MeasureString(text, font);
                    int bx = selection.X;
                    int by = selection.Y - (int)sz.Height - 6;
                    if (by < 5) by = selection.Bottom + 6;
                    g.FillRectangle(badgeBg, bx, by, sz.Width + 8, sz.Height + 4);
                    g.DrawString(text, font, textBrush, bx + 4, by + 2);
                }
            }
        }
    }
}
